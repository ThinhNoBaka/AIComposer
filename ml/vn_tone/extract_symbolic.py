"""Trích bảng "mỗi chữ một dòng" (chữ, thanh điệu, cao độ, nhịp) từ file karaoke .kar/.mid và MusicXML.

Cách dùng (từ thư mục gốc repo):
    python ml/vn_tone/extract_symbolic.py --input ml/vn_tone/data/raw --out ml/vn_tone/data/processed

Thư mục --input được tìm đệ quy: *.kar, *.mid, *.midi, *.musicxml, *.xml, *.mxl.
Ca sĩ/nhạc sĩ (artist_id) lấy theo thứ tự: file --artists (CSV hai cột file,artist), tên thư mục cha
(vd. raw/trinh_cong_son/diem_xua.kar), không có thì "unknown". Tách train/test theo artist_id nên
nên xếp file theo thư mục tác giả.

Đầu ra: syllables.parquet (hoặc syllables.csv nếu thiếu pandas/pyarrow) và manifest.csv (mỗi file một dòng,
kèm bảng mã đã đoán, số chữ, lỗi nếu có).
"""

from __future__ import annotations

import argparse
import csv
import sys
import unicodedata
from bisect import bisect_left
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from vn_common import (  # noqa: E402
    decode_vietnamese,
    decode_with,
    detect_key,
    finish_rows,
    parse_key_name,
    slug,
    write_manifest,
    write_rows,
)

MIDI_EXT = {".kar", ".mid", ".midi"}
XML_EXT = {".musicxml", ".xml", ".mxl"}
VOWELS = set("aăâeêioôơuưy")


def _has_vowel(s: str) -> bool:
    base = "".join(c for c in unicodedata.normalize("NFD", s.lower()) if not unicodedata.combining(c))
    return any(c in VOWELS or c in "aeiouy" for c in base)


# ---------- MIDI / KAR ----------


def _lyric_events(mf) -> list[tuple[int, bytes]]:
    """(tick tuyệt đối, bytes thô) của các sự kiện lời. Ưu tiên meta 'lyrics'; không có thì 'text' kiểu KAR."""
    per_track: dict[str, list[list[tuple[int, bytes]]]] = {"lyrics": [], "text": []}
    for track in mf.tracks:
        tick = 0
        found: dict[str, list[tuple[int, bytes]]] = {"lyrics": [], "text": []}
        for msg in track:
            tick += msg.time
            if msg.type in found:
                raw = msg.text.encode("latin-1", errors="replace")  # mido đọc theo latin-1 nên lấy lại được bytes gốc
                if msg.type == "text" and raw.startswith(b"@"):  # dòng thông tin của KAR (@T tên bài, @I...)
                    continue
                found[msg.type].append((tick, raw))
        for k in found:
            if found[k]:
                per_track[k].append(found[k])
    for kind in ("lyrics", "text"):
        if per_track[kind]:
            # Nhiều track cùng chứa lời (chép trùng) thì lấy track nhiều sự kiện nhất.
            return max(per_track[kind], key=len)
    return []


def _syllables_from_fragments(frags: list[tuple[int, str]]) -> list[dict]:
    """Ghép các mảnh lời karaoke thành âm tiết. '/' hoặc '\\' ở đầu mảnh, hay xuống dòng, là sang câu mới."""
    out: list[dict] = []
    new_line = True
    prev_space = True
    for tick, text in frags:
        t = text.replace("\r\n", "\n").replace("\r", "\n")
        if t[:1] in "/\\":
            new_line = True
            t = t[1:]
        lead_space = t[:1].isspace() or t[:1] == "-"
        ends_line = t.rstrip(" \t").endswith("\n")
        tokens = [w for w in t.replace("-", " ").split() if any(c.isalpha() for c in w)]
        for k, w in enumerate(tokens):
            glue = k == 0 and out and not lead_space and not prev_space and not new_line
            # Một âm tiết tiếng Việt chỉ có một cụm nguyên âm: hai mảnh đều có nguyên âm thì là hai chữ.
            if glue and not (_has_vowel(out[-1]["syllable"]) and _has_vowel(w)):
                out[-1]["syllable"] += w
                continue
            out.append({"tick": tick, "syllable": w, "new_line": new_line})
            new_line = False
        prev_space = t[-1:].isspace() or t[-1:] == "-" if t else prev_space
        if ends_line:
            new_line = True
    return out


def _note_lists(mf) -> list[list[tuple[int, int, int]]]:
    """Mỗi (track, kênh) không phải trống → danh sách nốt đơn âm (tick bắt đầu, tick kết thúc, pitch)."""
    groups: dict[tuple[int, int], list[tuple[int, int, int]]] = {}
    for ti, track in enumerate(mf.tracks):
        tick = 0
        active: dict[tuple[int, int], int] = {}
        for msg in track:
            tick += msg.time
            if msg.type not in ("note_on", "note_off") or msg.channel == 9:
                continue
            key = (msg.channel, msg.note)
            if msg.type == "note_on" and msg.velocity > 0:
                if key in active:  # note_on chồng: đóng nốt cũ
                    groups.setdefault((ti, msg.channel), []).append((active.pop(key), tick, msg.note))
                active[key] = tick
            elif key in active:
                groups.setdefault((ti, msg.channel), []).append((active.pop(key), tick, msg.note))
    out = []
    for notes in groups.values():
        notes.sort(key=lambda n: (n[0], -n[2]))
        mono: list[tuple[int, int, int]] = []
        for s, e, p in notes:  # nhiều nốt cùng lúc: giữ nốt cao nhất (giai điệu thường ở trên)
            if mono and mono[-1][0] == s:
                continue
            if mono and mono[-1][1] > s:
                mono[-1] = (mono[-1][0], s, mono[-1][2])
            if e > s:
                mono.append((s, e, p))
        if mono:
            out.append(mono)
    return out


def _match_score(notes: list[tuple[int, int, int]], ticks: list[int], tol: int) -> float:
    starts = [n[0] for n in notes]
    hit = 0
    for t in ticks:
        i = bisect_left(starts, t - tol)
        if i < len(starts) and starts[i] <= t + tol:
            hit += 1
    return hit / len(ticks) if ticks else 0.0


def extract_midi(path: Path, encoding: str | None = None) -> tuple[list[dict], dict]:
    """Trả về (danh sách chữ chưa đánh câu, thông tin). Mỗi chữ có pitch, onset_beat, dur_beat, melisma_notes."""
    import mido

    mf = mido.MidiFile(str(path), charset="latin-1", clip=True)
    tpb = mf.ticks_per_beat or 480
    events = _lyric_events(mf)
    if not events:
        return [], {"status": "không có lời"}
    enc = encoding or decode_vietnamese(b"\n".join(raw for _, raw in events))[1]
    sylls = _syllables_from_fragments([(tick, decode_with(raw, enc)) for tick, raw in events])
    if not sylls:
        return [], {"status": "không có chữ", "encoding": enc}
    tol = max(1, tpb // 4)
    cands = _note_lists(mf)
    if not cands:
        return [], {"status": "không có nốt", "encoding": enc}
    ticks = [s["tick"] for s in sylls]
    melody = max(cands, key=lambda ns: (_match_score(ns, ticks, tol), len(ns)))
    score = _match_score(melody, ticks, tol)
    if score < 0.5:
        return [], {"status": f"lời không khớp nốt ({score:.0%})", "encoding": enc}

    starts = [n[0] for n in melody]
    assigned: list[tuple[dict, int]] = []
    ptr = 0
    carry = False
    for s in sylls:
        j = bisect_left(starts, s["tick"] - tol, lo=ptr)
        if j >= len(melody) or melody[j][0] > s["tick"] + tpb:
            carry = carry or s["new_line"]  # chữ không có nốt thì bỏ, nhưng giữ dấu sang câu mới cho chữ sau
            continue
        assigned.append(({**s, "new_line": s["new_line"] or carry}, j))
        carry = False
        ptr = j + 1
    rows = []
    for k, (s, j) in enumerate(assigned):
        nxt_tick = assigned[k + 1][0]["tick"] if k + 1 < len(assigned) else None
        nxt_j = assigned[k + 1][1] if k + 1 < len(assigned) else len(melody)
        last = j
        # Nốt ngân thêm: liền nhau (không lặng quá nửa phách) và trước chữ kế tiếp.
        while last + 1 < nxt_j:
            n = melody[last + 1]
            if n[0] - melody[last][1] > tpb // 2 or (nxt_tick is not None and n[0] >= nxt_tick - tol):
                break
            last += 1
        rows.append(
            {
                "syllable": s["syllable"],
                "pitch": melody[j][2],
                "onset_beat": melody[j][0] / tpb,
                "dur_beat": (melody[last][1] - melody[j][0]) / tpb,
                "melisma_notes": last - j + 1,
                "new_line": s["new_line"],
            }
        )
    pitches = [n[2] for n in melody]
    weights = [(n[1] - n[0]) / tpb for n in melody]
    key = detect_key(pitches, weights)
    return rows, {"status": "ok", "encoding": enc, "key": key, "match": round(score, 3)}


# ---------- MusicXML ----------


def extract_musicxml(path: Path) -> tuple[list[dict], dict]:
    from music21 import chord, converter, note

    score = converter.parse(str(path))
    parts = list(score.parts) or [score]
    part = next((p for p in parts if any(n.lyric for n in p.recurse().notes)), None)
    if part is None:
        return [], {"status": "không có lời"}
    rows: list[dict] = []
    pitches, weights = [], []
    cur: dict | None = None
    for el in part.flatten().notesAndRests:
        if el.duration.isGrace:
            continue
        if isinstance(el, note.Rest):
            cur = None  # lặng: chữ sau không còn là ngân tiếp
            continue
        midi = max(p.midi for p in el.pitches) if isinstance(el, chord.Chord) else el.pitch.midi
        onset = float(el.getOffsetInHierarchy(score)) if hasattr(el, "getOffsetInHierarchy") else float(el.offset)
        dur = float(el.duration.quarterLength)
        pitches.append(midi)
        weights.append(dur)
        tie = el.tie.type if el.tie is not None else None
        words = [w for w in (el.lyric or "").replace("-", " ").split() if any(c.isalpha() for c in w)]
        if cur is not None and (tie in ("continue", "stop") or not words):
            cur["dur_beat"] = onset + dur - cur["onset_beat"]
            if tie not in ("continue", "stop"):
                cur["melisma_notes"] += 1
            continue
        if not words:
            continue
        for k, w in enumerate(words):  # vài chữ trên một nốt (hiếm): chia đều trường độ
            part_dur = dur / len(words)
            cur = {"syllable": w, "pitch": midi, "onset_beat": onset + k * part_dur, "dur_beat": part_dur, "melisma_notes": 1}
            rows.append(cur)
    if not rows:
        return [], {"status": "không có chữ"}
    return rows, {"status": "ok", "encoding": "utf-8", "key": detect_key(pitches, weights)}


# ---------- Chạy ----------


def load_artist_map(path: Path | None) -> dict[str, str]:
    if not path:
        return {}
    with path.open(encoding="utf-8") as f:
        return {Path(r["file"]).stem: r["artist"] for r in csv.DictReader(f)}


def artist_for(path: Path, root: Path, amap: dict[str, str]) -> str:
    if path.stem in amap:
        return slug(amap[path.stem])
    rel = path.relative_to(root)
    return slug(rel.parts[-2]) if len(rel.parts) >= 2 else "unknown"


def extract_file(path: Path, root: Path, amap: dict[str, str], encoding: str | None = None, trust_keysig: bool = False) -> tuple[list[dict], dict]:
    ext = path.suffix.lower()
    source = "kar" if ext == ".kar" else "midi" if ext in MIDI_EXT else "musicxml"
    song_id = slug(str(path.relative_to(root).with_suffix("")))
    artist = artist_for(path, root, amap)
    info: dict = {"song_id": song_id, "artist_id": artist, "source": source, "path": str(path)}
    try:
        sylls, meta = extract_midi(path, encoding) if ext in MIDI_EXT else extract_musicxml(path)
    except Exception as exc:  # noqa: BLE001 - file hỏng: ghi lỗi vào manifest rồi đi tiếp
        return [], {**info, "status": f"lỗi: {type(exc).__name__}: {exc}"[:200], "n_syllables": 0}
    info.update({k: v for k, v in meta.items() if k in ("status", "encoding")})
    if not sylls:
        return [], {**info, "n_syllables": 0}
    key = meta["key"]
    if trust_keysig and ext in MIDI_EXT:
        import mido

        for track in mido.MidiFile(str(path), clip=True).tracks:
            ks = next((m.key for m in track if m.type == "key_signature"), None)
            if ks and parse_key_name(ks):
                key = parse_key_name(ks)
                break
    rows = finish_rows(sylls, song_id, artist, source, key)
    info.update(
        {"n_syllables": len(rows), "n_lines": (rows[-1]["line"] + 1) if rows else 0, "key_tonic": key[0], "key_mode": key[1]}
    )
    return rows, info


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", type=Path, default=HERE / "data" / "raw")
    ap.add_argument("--out", type=Path, default=HERE / "data" / "processed")
    ap.add_argument("--artists", type=Path, default=None, help="CSV cột file,artist (tuỳ chọn)")
    ap.add_argument("--encoding", default=None, help="ép bảng mã lời karaoke: utf-8 | cp1258 | vni | latin-1 (mặc định tự đoán)")
    ap.add_argument("--trust-keysig", action="store_true", help="dùng key_signature trong MIDI thay vì tự dò giọng")
    args = ap.parse_args(argv)

    files = sorted(p for p in args.input.rglob("*") if p.is_file() and p.suffix.lower() in MIDI_EXT | XML_EXT)
    if not files:
        print(f"Không thấy file .kar/.mid/.musicxml nào trong {args.input}", file=sys.stderr)
        return 1
    amap = load_artist_map(args.artists)
    all_rows, manifest = [], []
    for k, f in enumerate(files):
        rows, info = extract_file(f, args.input, amap, args.encoding, args.trust_keysig)
        all_rows.extend(rows)
        manifest.append(info)
        if (k + 1) % 100 == 0:
            print(f"  {k + 1}/{len(files)} file, {len(all_rows)} chữ")
    out = write_rows(all_rows, args.out)
    write_manifest(manifest, args.out)
    ok = sum(1 for m in manifest if m.get("n_syllables"))
    print(f"{ok}/{len(files)} file có lời khớp nốt, {len(all_rows)} chữ → {out}")
    print(f"Chi tiết từng file (bảng mã, lỗi): {args.out / 'manifest.csv'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
