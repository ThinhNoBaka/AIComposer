"""Trích bảng chữ ↔ nốt từ bản thu bài hát thật (chạy trên Colab có GPU, xem colab_vn_tone.ipynb).

Các bước cho mỗi bài:
  1. (tuỳ chọn) tải audio bằng yt-dlp;
  2. tách giọng hát bằng Demucs (htdemucs, lấy stem vocals);
  3. dò F0 bằng torchcrepe (có GPU) hoặc pYIN của librosa;
  4. chia F0 thành nốt (cắt ở chỗ lặng hoặc chỗ cao độ đổi hẳn);
  5. căn lời với giọng hát bằng wav2vec2 CTC tiếng Việt (mặc định nguyenvulebinh/wav2vec2-base-vietnamese-250h),
     thuật toán căn CTC (Viterbi) viết bằng numpy ở đây;
  6. ghép mỗi chữ với các nốt nằm trong khoảng thời gian của nó → cùng schema với extract_symbolic.py.

Lời: file .lrc (có mốc thời gian từng câu, căn chính xác hơn) hoặc .txt (mỗi dòng một câu) cùng tên với audio.
Thư viện nặng (torch, transformers, demucs, torchcrepe, yt-dlp) chỉ import bên trong hàm cần dùng,
nên các hàm thuần (đọc LRC, chia nốt, căn CTC, ghép chữ-nốt) chạy và test được ở máy không có GPU.

Cách dùng:
    python ml/vn_tone/extract_audio.py --audio-dir ml/vn_tone/data/audio --out ml/vn_tone/data/processed_audio
    python ml/vn_tone/extract_audio.py --urls ml/vn_tone/data/urls.csv --download-only   # csv: url,song_id,artist_id
"""

from __future__ import annotations

import argparse
import csv
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from vn_common import bare_word, detect_key, finish_rows, slug, write_manifest, write_rows  # noqa: E402

SR = 16000
AUDIO_EXT = {".wav", ".mp3", ".flac", ".m4a", ".ogg", ".opus", ".webm"}
DEFAULT_ASR = "nguyenvulebinh/wav2vec2-base-vietnamese-250h"


# ---------- Lời ----------

_LRC_TIME = re.compile(r"\[(\d+):(\d+(?:[.:]\d+)?)\]")


def parse_lyrics(text: str) -> list[tuple[float | None, list[str]]]:
    """Đọc .lrc hoặc .txt → [(giây bắt đầu câu hoặc None, [chữ...])]. Bỏ dòng thẻ [ar:], [ti:] và dòng trống."""
    out: list[tuple[float | None, list[str]]] = []
    for raw in unicodedata.normalize("NFC", text).splitlines():
        times = [int(m.group(1)) * 60 + float(m.group(2).replace(":", ".")) for m in _LRC_TIME.finditer(raw)]
        body = _LRC_TIME.sub("", raw)
        if re.fullmatch(r"\s*\[[a-zA-Z]+:.*\]\s*", body):
            continue
        words = [w for w in re.split(r"[\s\-–—]+", body) if bare_word(w)]
        if not words:
            continue
        for t in times or [None]:  # một dòng LRC có thể lặp nhiều mốc (điệp khúc)
            out.append((t, words))
    if all(t is not None for t, _ in out):
        out.sort(key=lambda x: x[0])
    return out


# ---------- Tải và tách giọng ----------


def download_audio(url: str, out_dir: Path, name: str) -> Path:
    """Tải audio bằng yt-dlp (chỉ dùng cho mục đích học tập, cá nhân)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / f"{name}.%(ext)s"
    subprocess.run(
        [sys.executable, "-m", "yt_dlp", "-x", "--audio-format", "wav", "-o", str(target), url], check=True
    )
    return out_dir / f"{name}.wav"


def separate_vocals(path: Path, out_dir: Path, model: str = "htdemucs") -> Path:
    """Demucs tách 2 stem (vocals / no_vocals); trả về file vocals.wav."""
    vocals = out_dir / model / path.stem / "vocals.wav"
    if not vocals.exists():
        subprocess.run([sys.executable, "-m", "demucs", "--two-stems", "vocals", "-n", model, "-o", str(out_dir), str(path)], check=True)
    return vocals


def load_wav(path: Path, sr: int = SR) -> np.ndarray:
    import librosa

    y, _ = librosa.load(str(path), sr=sr, mono=True)
    return y.astype(np.float32)


# ---------- Cao độ và nốt ----------


def track_f0(y: np.ndarray, sr: int = SR, method: str = "auto", hop: int = 160) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(thời điểm giây, MIDI số thực hoặc NaN, độ tin cậy 0..1) mỗi 10 ms."""
    if method in ("auto", "crepe"):
        try:
            import torch
            import torchcrepe

            device = "cuda" if torch.cuda.is_available() else "cpu"
            audio = torch.tensor(y)[None]
            f0, period = torchcrepe.predict(
                audio, sr, hop, 65.0, 1050.0, "full", batch_size=1024, device=device, return_periodicity=True
            )
            period = torchcrepe.filter.median(period, 3)
            f0 = torchcrepe.filter.mean(f0, 3)
            f0, conf = f0[0].cpu().numpy(), period[0].cpu().numpy()
            midi = 69 + 12 * np.log2(np.maximum(f0, 1e-6) / 440.0)
            midi[conf < 0.3] = np.nan
            return np.arange(len(midi)) * hop / sr, midi, conf
        except ImportError:
            if method == "crepe":
                raise
    import librosa

    f0, _, prob = librosa.pyin(y, fmin=65.0, fmax=1050.0, sr=sr, frame_length=1024, hop_length=hop)
    with np.errstate(divide="ignore", invalid="ignore"):
        midi = 69 + 12 * np.log2(f0 / 440.0)
    return np.arange(len(midi)) * hop / sr, midi, np.nan_to_num(prob)


def notes_from_f0(
    times: np.ndarray, midi: np.ndarray, min_dur: float = 0.08, jump: float = 0.8, jump_frames: int = 4, gap_frames: int = 3
) -> list[tuple[float, float, float]]:
    """Chia đường cao độ thành nốt [(onset, offset, midi)]: cắt ở chỗ lặng ≥ gap_frames khung
    hoặc chỗ lệch hơn `jump` nửa cung so với trung vị nốt đang chạy suốt `jump_frames` khung."""
    hop = float(times[1] - times[0]) if len(times) > 1 else 0.01
    voiced = np.isfinite(midi)
    if voiced.any():
        from scipy.ndimage import median_filter

        filled = np.where(voiced, midi, np.nanmedian(midi[voiced]))
        midi = np.where(voiced, median_filter(filled, size=5, mode="nearest"), np.nan)
    segs: list[list[int]] = []
    cur: list[int] = []
    pend: list[int] = []
    gap = 0
    for i in range(len(midi)):
        if not voiced[i]:
            gap += 1
            if cur and gap >= gap_frames:
                segs.append(cur)
                cur, pend = [], []
            continue
        gap = 0
        if not cur:
            cur = [i]
            continue
        ref = float(np.median(midi[cur[-15:]]))
        if abs(midi[i] - ref) > jump:
            pend.append(i)
            if len(pend) >= jump_frames:
                segs.append(cur)
                cur, pend = pend, []
        else:
            cur.extend(pend)
            pend = []
            cur.append(i)
    if cur:
        segs.append(cur + pend)
    out = []
    for s in segs:
        on, off = float(times[s[0]]), float(times[s[-1]] + hop)
        if off - on >= min_dur:
            out.append((on, off, float(np.median(midi[s]))))
    return out


# ---------- Căn lời (CTC forced alignment) ----------


def ctc_align(log_probs: np.ndarray, targets: list[int], blank: int) -> list[tuple[int, int]]:
    """Căn chuỗi token vào ma trận log-xác suất CTC [T, V] bằng Viterbi.

    Trả về (khung đầu, khung cuối) cho từng token đích. Thiếu khung (T quá ngắn) thì báo ValueError.
    """
    T = log_probs.shape[0]
    L = len(targets)
    if L == 0:
        return []
    ext = [blank]
    for t in targets:
        ext += [t, blank]
    S = len(ext)
    ext_arr = np.array(ext)
    # Cho phép nhảy qua blank giữa hai token khác nhau.
    skip = np.zeros(S, dtype=bool)
    for s in range(2, S):
        skip[s] = ext[s] != blank and ext[s] != ext[s - 2]
    neg = -1e30
    dp = np.full((T, S), neg)
    back = np.zeros((T, S), dtype=np.int8)  # 0: ở lại, 1: từ s-1, 2: từ s-2
    dp[0, 0] = log_probs[0, ext[0]]
    if S > 1:
        dp[0, 1] = log_probs[0, ext[1]]
    for t in range(1, T):
        prev = dp[t - 1]
        stay = prev
        step = np.concatenate([[neg], prev[:-1]])
        jump = np.where(skip, np.concatenate([[neg, neg], prev[:-2]]), neg)
        cand = np.stack([stay, step, jump])
        arg = np.argmax(cand, axis=0)
        dp[t] = cand[arg, np.arange(S)] + log_probs[t, ext_arr]
        back[t] = arg
    end = S - 1 if S == 1 or dp[T - 1, S - 1] >= dp[T - 1, S - 2] else S - 2
    if dp[T - 1, end] <= neg / 2:
        raise ValueError("không đủ khung để căn lời")
    path = np.zeros(T, dtype=int)
    s = end
    for t in range(T - 1, -1, -1):
        path[t] = s
        s -= int(back[t, s])
    spans: list[list[int]] = [[-1, -1] for _ in range(L)]
    for t, s in enumerate(path):
        if s % 2 == 1:
            k = s // 2
            if spans[k][0] < 0:
                spans[k][0] = t
            spans[k][1] = t
    return [(a, b) for a, b in spans]


def words_to_tokens(words: list[str], vocab: dict[str, int], delimiter: str = "|") -> tuple[list[int], list[int]]:
    """Chữ → token ký tự của wav2vec2 (bỏ ký tự ngoài bảng), kèm chỉ số chữ của từng token (-1 cho dấu cách chữ)."""
    tokens, owner = [], []
    for i, w in enumerate(words):
        chars = [c for c in bare_word(w) if c in vocab]
        if not chars:
            continue
        if tokens and delimiter in vocab:
            tokens.append(vocab[delimiter])
            owner.append(-1)
        for c in chars:
            tokens.append(vocab[c])
            owner.append(i)
    return tokens, owner


class Aligner:
    """Bọc mô hình wav2vec2 CTC tiếng Việt (transformers)."""

    def __init__(self, name: str = DEFAULT_ASR, device: str | None = None):
        import torch
        from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor

        self.torch = torch
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self.processor = Wav2Vec2Processor.from_pretrained(name)
        self.model = Wav2Vec2ForCTC.from_pretrained(name).to(self.device).eval()
        self.vocab = {k.lower(): v for k, v in self.processor.tokenizer.get_vocab().items()}
        self.blank = self.processor.tokenizer.pad_token_id

    def log_probs(self, y: np.ndarray, chunk_sec: float = 30.0) -> tuple[np.ndarray, float]:
        """Log-xác suất CTC cả bài (chia khúc 30 s cho đỡ tốn bộ nhớ) và số giây mỗi khung."""
        outs = []
        step = int(chunk_sec * SR)
        for a in range(0, len(y), step):
            piece = y[a : a + step]
            if len(piece) < SR // 10:
                continue
            inp = self.processor(piece, sampling_rate=SR, return_tensors="pt").input_values.to(self.device)
            with self.torch.inference_mode():
                logits = self.model(inp).logits[0]
            outs.append(self.torch.log_softmax(logits.float(), dim=-1).cpu().numpy())
        lp = np.concatenate(outs) if outs else np.zeros((0, len(self.vocab)))
        return lp, len(y) / SR / max(1, len(lp))

    def align_words(self, y: np.ndarray, words: list[str], offset: float = 0.0) -> list[tuple[int, str, float, float]]:
        lp, sec = self.log_probs(y)
        return align_with_log_probs(lp, sec, words, self.vocab, self.blank, offset)


def align_with_log_probs(
    lp: np.ndarray, sec_per_frame: float, words: list[str], vocab: dict[str, int], blank: int, offset: float = 0.0
) -> list[tuple[int, str, float, float]]:
    """(thứ tự chữ, chữ, giây bắt đầu, giây kết thúc) cho các chữ có ký tự trong bảng của mô hình."""
    tokens, owner = words_to_tokens(words, vocab)
    if not tokens:
        return []
    spans = ctc_align(lp, tokens, blank)
    found: dict[int, list[int]] = {}
    for (a, b), w in zip(spans, owner):
        if w < 0 or a < 0:
            continue
        cur = found.setdefault(w, [a, b])
        cur[0], cur[1] = min(cur[0], a), max(cur[1], b)
    return [(i, words[i], offset + a * sec_per_frame, offset + (b + 1) * sec_per_frame) for i, (a, b) in sorted(found.items())]


# ---------- Ghép chữ với nốt ----------


def match_words_to_notes(
    lines_words: list[list[tuple[str, float, float]]], notes: list[tuple[float, float, float]], bpm: float, tol: float = 0.08
) -> list[dict]:
    """Mỗi chữ lấy các nốt có onset nằm trong [đầu chữ - tol, đầu chữ sau - tol) hoặc phủ phần lớn chữ.

    Trả về danh sách chữ (chưa đánh câu) dạng finish_rows cần; chữ không có nốt bị bỏ.
    """
    beat = 60.0 / bpm
    flat = [(li, w, s, e) for li, ws in enumerate(lines_words) for (w, s, e) in ws]
    flat.sort(key=lambda x: x[2])
    out = []
    used = set()
    prev_line = None
    for k, (li, w, s, e) in enumerate(flat):
        nxt = flat[k + 1][2] if k + 1 < len(flat) else e + 1.0
        limit = min(nxt, e + 0.5) - tol
        idx = [
            j
            for j, (on, off, _) in enumerate(notes)
            if j not in used and ((s - tol <= on < limit) or (on < s and off > s + 0.5 * (e - s)))
        ]
        if not idx:
            continue
        used.update(idx)
        first, last = notes[idx[0]], notes[idx[-1]]
        out.append(
            {
                "syllable": w,
                "pitch": int(round(first[2])),
                "onset_beat": first[0] / beat,
                "dur_beat": (last[1] - first[0]) / beat,
                "melisma_notes": len(idx),
                "new_line": li != prev_line,
            }
        )
        prev_line = li
    return out


def estimate_bpm(y: np.ndarray, sr: int = SR) -> float:
    import librosa

    tempo = librosa.feature.rhythm.tempo(y=y, sr=sr) if hasattr(librosa.feature, "rhythm") else librosa.beat.tempo(y=y, sr=sr)
    return float(np.atleast_1d(tempo)[0]) or 100.0


def process_song(
    audio: Path, lyrics: Path, song_id: str, artist_id: str, work: Path, aligner: Aligner, f0_method: str = "auto", separate: bool = True
) -> tuple[list[dict], dict]:
    lines = parse_lyrics(lyrics.read_text(encoding="utf-8"))
    if not lines:
        return [], {"status": "không có lời"}
    mix = load_wav(audio)
    bpm = estimate_bpm(mix)
    vocals = load_wav(separate_vocals(audio, work / "demucs")) if separate else mix
    times, midi, _ = track_f0(vocals, SR, f0_method)
    notes = notes_from_f0(times, midi)
    if all(t is not None for t, _ in lines):
        # Có mốc thời gian từng câu: căn từng câu trong khoảng của nó (nhanh và ít trượt hơn).
        aligned = []
        for i, (t, words) in enumerate(lines):
            a = max(0.0, t - 0.3)
            b = lines[i + 1][0] if i + 1 < len(lines) else len(vocals) / SR
            seg = vocals[int(a * SR) : int(b * SR)]
            try:
                aligned.append([(w, s, e) for _, w, s, e in aligner.align_words(seg, words, offset=a)])
            except ValueError:
                aligned.append([])
    else:
        words, line_of = [], []
        for li, (_, ws) in enumerate(lines):
            words += ws
            line_of += [li] * len(ws)
        aligned = [[] for _ in lines]
        for i, w, s, e in aligner.align_words(vocals, words):  # chia lại theo câu
            aligned[line_of[i]].append((w, s, e))
    sylls = match_words_to_notes(aligned, notes, bpm)
    if not sylls:
        return [], {"status": "không ghép được chữ với nốt"}
    key = detect_key([int(round(n[2])) for n in notes], [n[1] - n[0] for n in notes])
    rows = finish_rows(sylls, song_id, artist_id, "audio", key)
    return rows, {"status": "ok", "n_syllables": len(rows), "n_lines": rows[-1]["line"] + 1, "key_tonic": key[0], "key_mode": key[1]}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--audio-dir", type=Path, default=HERE / "data" / "audio", help="audio + lời (.lrc/.txt cùng tên); thư mục con = tác giả")
    ap.add_argument("--urls", type=Path, default=None, help="CSV url,song_id,artist_id để tải bằng yt-dlp vào --audio-dir")
    ap.add_argument("--out", type=Path, default=HERE / "data" / "processed_audio")
    ap.add_argument("--work", type=Path, default=HERE / "data" / "work", help="chỗ để file tách giọng tạm")
    ap.add_argument("--asr", default=DEFAULT_ASR)
    ap.add_argument("--f0", choices=["auto", "crepe", "pyin"], default="auto")
    ap.add_argument("--no-separate", action="store_true", help="bỏ bước Demucs (audio đã là giọng hát)")
    ap.add_argument("--download-only", action="store_true", help="chỉ tải audio theo --urls rồi dừng")
    args = ap.parse_args(argv)

    if args.urls:
        with args.urls.open(encoding="utf-8") as f:
            for r in csv.DictReader(f):
                folder = args.audio_dir / slug(r.get("artist_id") or "unknown")
                if not (folder / f"{r['song_id']}.wav").exists():
                    download_audio(r["url"], folder, r["song_id"])
        if args.download_only:
            return 0

    pairs = []
    for a in sorted(p for p in args.audio_dir.rglob("*") if p.suffix.lower() in AUDIO_EXT):
        lyr = next((a.with_suffix(ext) for ext in (".lrc", ".txt") if a.with_suffix(ext).exists()), None)
        if lyr:
            pairs.append((a, lyr))
    if not pairs:
        print(f"Không thấy cặp audio + lời (.lrc/.txt cùng tên) trong {args.audio_dir}", file=sys.stderr)
        return 1
    aligner = Aligner(args.asr)
    all_rows, manifest = [], []
    for a, lyr in pairs:
        rel = a.relative_to(args.audio_dir)
        song_id = slug(str(rel.with_suffix("")))
        artist = slug(rel.parts[-2]) if len(rel.parts) >= 2 else "unknown"
        try:
            rows, info = process_song(a, lyr, song_id, artist, args.work, aligner, args.f0, not args.no_separate)
        except Exception as exc:  # noqa: BLE001 - bài lỗi thì ghi lại rồi làm bài khác
            rows, info = [], {"status": f"lỗi: {type(exc).__name__}: {exc}"[:200]}
        print(f"  {song_id}: {info.get('status')} ({len(rows)} chữ)")
        all_rows.extend(rows)
        manifest.append({"song_id": song_id, "artist_id": artist, "source": "audio", "path": str(a), "encoding": "utf-8", **info})
    out = write_rows(all_rows, args.out)
    write_manifest(manifest, args.out)
    print(f"{len(all_rows)} chữ → {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
