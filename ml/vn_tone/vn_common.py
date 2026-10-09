"""Phần dùng chung cho các script thanh điệu → giai điệu: thanh điệu, schema, đọc/ghi bảng, dò giọng."""

from __future__ import annotations

import csv
import math
import re
import unicodedata
from pathlib import Path

TONES = ("ngang", "huyen", "sac", "hoi", "nga", "nang")

# Giống hệt frontend/src/core/lyrics.ts: dấu thanh là ký tự tổ hợp sau khi tách NFD.
MARK_TONE = {
    "̀": "huyen",  # huyền
    "́": "sac",  # sắc
    "̉": "hoi",  # hỏi
    "̃": "nga",  # ngã
    "̣": "nang",  # nặng
}

# Một dòng = một âm tiết (chữ) hát trên một hoặc nhiều nốt.
SCHEMA = [
    "song_id",
    "artist_id",
    "source",  # kar | midi | musicxml | audio
    "line",  # thứ tự câu trong bài
    "idx_in_line",  # thứ tự chữ trong câu
    "syllable",
    "tone",
    "pitch",  # MIDI của nốt đầu tiên của chữ
    "onset_beat",
    "dur_beat",  # từ đầu nốt đầu tới cuối nốt cuối của chữ
    "interval_prev",  # nửa cung so với chữ trước trong cùng câu (trống ở chữ đầu câu)
    "key_tonic",  # 0..11 (0 = Đô)
    "key_mode",  # major | minor
    "melisma_notes",  # số nốt chữ này ngân qua (1 = một chữ một nốt)
]

def bare_word(word: str) -> str:
    """Chỉ giữ chữ cái, viết thường, dạng NFC (như bareWord ở frontend)."""
    return "".join(c for c in unicodedata.normalize("NFC", word).lower() if c.isalpha())


def tone_of(word: str) -> str:
    for ch in unicodedata.normalize("NFD", bare_word(word)):
        t = MARK_TONE.get(ch)
        if t:
            return t
    return "ngang"


# ---------- Giải mã chữ tiếng Việt trong file karaoke cũ ----------

VIET_CHARS = set(
    "aàáảãạăằắẳẵặâầấẩẫậbcdđeèéẻẽẹêềếểễệghiìíỉĩịklmnoòóỏõọôồốổỗộơờớởỡợpqrstuùúủũụưừứửữựvxyỳýỷỹỵ"
)

# VNI-Windows: chữ gốc + một byte dấu phía sau (đọc theo cp1252 rồi thay).
_VNI_SINGLE = {
    "ñ": "đ", "Ñ": "Đ", "ö": "ư", "Ö": "Ư", "ô": "ơ", "Ô": "Ơ",
    "æ": "ỉ", "Æ": "Ỉ", "ó": "ĩ", "Ó": "Ĩ", "ò": "ị", "Ò": "Ị",
}
_VNI_MARKS = {
    "ù": "́", "ø": "̀", "û": "̉", "õ": "̃", "ï": "̣",
    "â": "̂", "ê": "̆",
    "á": "̂́", "à": "̂̀", "å": "̂̉", "ã": "̂̃", "ä": "̣̂",
    "é": "̆́", "è": "̆̀", "ú": "̆̉", "ü": "̆̃", "ë": "̣̆",
}
_VNI_MARKS.update({k.upper(): v for k, v in list(_VNI_MARKS.items())})


def _vni_to_unicode(text: str) -> str:
    out = []
    for ch in text:
        if ch in _VNI_SINGLE:
            out.append(_VNI_SINGLE[ch])
        elif ch in _VNI_MARKS and out and out[-1][-1:].isalpha():
            out.append(_VNI_MARKS[ch])
        else:
            out.append(ch)
    return unicodedata.normalize("NFC", "".join(out))


def viet_score(text: str) -> float:
    """Tỉ lệ ký tự là chữ tiếng Việt hợp lệ (trên tổng chữ cái); dùng để chọn bảng mã đúng."""
    letters = [c for c in text.lower() if c.isalpha()]
    if not letters:
        return 0.0
    good = sum(c in VIET_CHARS for c in letters)
    accented = sum(c in VIET_CHARS and not c.isascii() for c in letters)
    return good / len(letters) + 0.01 * accented / len(letters)


def decode_with(raw: bytes, encoding: str) -> str:
    """Giải mã theo bảng mã đã chọn bằng decode_vietnamese (lỗi thì thay ký tự)."""
    if encoding == "vni":
        return _vni_to_unicode(raw.decode("cp1252", errors="replace"))
    return unicodedata.normalize("NFC", raw.decode(encoding, errors="replace"))


def decode_vietnamese(raw: bytes) -> tuple[str, str]:
    """Giải mã cố gắng nhất: thử UTF-8, cp1258 (dấu tổ hợp), VNI-Windows, cuối cùng latin-1.

    Trả về (chuỗi NFC, tên bảng mã đã chọn).
    """
    candidates: list[tuple[str, str]] = []
    try:
        candidates.append(("utf-8", raw.decode("utf-8")))
    except UnicodeDecodeError:
        pass
    for enc in ("cp1258",):
        try:
            candidates.append((enc, raw.decode(enc)))
        except UnicodeDecodeError:
            pass
    candidates.append(("vni", _vni_to_unicode(raw.decode("cp1252", errors="replace"))))
    candidates.append(("latin-1", raw.decode("latin-1")))
    best_enc, best_text, best_score = "latin-1", "", -1.0
    for enc, text in candidates:
        text = unicodedata.normalize("NFC", text)
        score = viet_score(text)
        if score > best_score + 1e-9:  # hoà điểm thì giữ bảng mã thử trước
            best_enc, best_text, best_score = enc, text, score
    return best_text, best_enc


# ---------- Dò giọng (Krumhansl–Kessler, giống backend/app/humming/keys.py) ----------

_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]


def _corr(a: list[float], b: list[float]) -> float:
    ma, mb = sum(a) / len(a), sum(b) / len(b)
    num = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    den = math.sqrt(sum((x - ma) ** 2 for x in a) * sum((y - mb) ** 2 for y in b))
    return num / den if den else 0.0


def detect_key(pitches: list[int], weights: list[float] | None = None) -> tuple[int, str]:
    hist = [0.0] * 12
    for p, w in zip(pitches, weights or [1.0] * len(pitches)):
        hist[int(p) % 12] += w
    if not any(hist):
        return 0, "major"
    best = (-2.0, 0, "major")
    for tonic in range(12):
        rot = hist[tonic:] + hist[:tonic]
        for mode, prof in (("major", _MAJOR), ("minor", _MINOR)):
            best = max(best, (_corr(rot, prof), tonic, mode))
    return best[1], best[2]


_KEY_NAMES = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def parse_key_name(name: str) -> tuple[int, str] | None:
    """'C', 'Am', 'F#m', 'Bb' (key_signature của mido) → (tonic, mode)."""
    m = re.fullmatch(r"([A-G])([#b]?)(m?)", name.strip())
    if not m:
        return None
    pc = _KEY_NAMES[m.group(1)] + {"#": 1, "b": -1, "": 0}[m.group(2)]
    return pc % 12, "minor" if m.group(3) else "major"


# ---------- Chia câu khi file không đánh dấu ----------

PHRASE_GAP_BEATS = 1.0  # lặng từ 1 phách: hết câu (giống PHRASE_GAP ở frontend)
PHRASE_HOLD_BEATS = 2.0  # nốt ngân từ 2 phách: hết câu (giống PHRASE_HOLD)


def finish_rows(sylls: list[dict], song_id: str, artist_id: str, source: str, key: tuple[int, str]) -> list[dict]:
    """Điền line/idx_in_line/interval_prev/tone cho danh sách chữ đã có pitch, onset_beat, dur_beat.

    Mỗi phần tử `sylls` cần: syllable, pitch, onset_beat, dur_beat, melisma_notes và tuỳ chọn
    new_line (True nếu file đánh dấu chữ này mở đầu câu mới). Không có dấu câu nào thì chia theo
    chỗ lặng/nốt ngân dài như frontend.
    """
    sylls = [s for s in sylls if bare_word(s["syllable"])]
    sylls.sort(key=lambda s: s["onset_beat"])
    has_marks = any(s.get("new_line") for s in sylls[1:])
    rows: list[dict] = []
    line, idx, prev = 0, 0, None
    for s in sylls:
        if prev is not None:
            if has_marks:
                new = bool(s.get("new_line"))
            else:
                gap = s["onset_beat"] - (prev["onset_beat"] + prev["dur_beat"])
                new = gap >= PHRASE_GAP_BEATS - 1e-6 or prev["dur_beat"] >= PHRASE_HOLD_BEATS - 1e-6
            if new:
                line, idx = line + 1, 0
            else:
                idx += 1
        rows.append(
            {
                "song_id": song_id,
                "artist_id": artist_id,
                "source": source,
                "line": line,
                "idx_in_line": idx,
                "syllable": bare_word(s["syllable"]),
                "tone": tone_of(s["syllable"]),
                "pitch": int(s["pitch"]),
                "onset_beat": round(float(s["onset_beat"]), 4),
                "dur_beat": round(float(s["dur_beat"]), 4),
                "interval_prev": None if idx == 0 else int(s["pitch"]) - int(rows[-1]["pitch"]),
                "key_tonic": int(key[0]),
                "key_mode": key[1],
                "melisma_notes": int(s.get("melisma_notes", 1)),
            }
        )
        prev = s
    return rows


# ---------- Đọc/ghi bảng ----------


def write_rows(rows: list[dict], out_dir: Path, name: str = "syllables") -> Path:
    """Ghi parquet nếu có pandas + pyarrow, không thì CSV (UTF-8). Trả về đường dẫn đã ghi."""
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        import pandas as pd

        df = pd.DataFrame(rows, columns=SCHEMA)
        df["interval_prev"] = df["interval_prev"].astype("Int64")
        path = out_dir / f"{name}.parquet"
        df.to_parquet(path, index=False)
        return path
    except Exception:  # noqa: BLE001 - thiếu pandas/pyarrow thì dùng CSV
        path = out_dir / f"{name}.csv"
        with path.open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=SCHEMA)
            w.writeheader()
            for r in rows:
                w.writerow({k: ("" if r.get(k) is None else r.get(k)) for k in SCHEMA})
        return path


def _cast(row: dict) -> dict:
    out = dict(row)
    for k in ("line", "idx_in_line", "pitch", "key_tonic", "melisma_notes"):
        out[k] = int(float(out[k]))
    for k in ("onset_beat", "dur_beat"):
        out[k] = float(out[k])
    iv = out.get("interval_prev")
    out["interval_prev"] = None if iv in (None, "", "nan", "<NA>") or (isinstance(iv, float) and math.isnan(iv)) else int(float(iv))
    out["song_id"], out["artist_id"] = str(out["song_id"]), str(out["artist_id"])
    return out


def read_rows(path: Path) -> list[dict]:
    """Đọc lại bảng chữ (parquet hoặc CSV). Nhận cả thư mục (đọc mọi syllables*.parquet/csv trong đó)."""
    path = Path(path)
    if path.is_dir():
        files = sorted(path.glob("*.parquet")) + sorted(path.glob("*.csv"))
        files = [f for f in files if f.name != "manifest.csv"]
        return [r for f in files for r in read_rows(f)]
    if path.suffix == ".parquet":
        import pandas as pd

        df = pd.read_parquet(path)
        return [_cast(r) for r in df.astype(object).where(df.notna(), None).to_dict("records")]
    with path.open(encoding="utf-8") as f:
        return [_cast(r) for r in csv.DictReader(f)]


def write_manifest(entries: list[dict], out_dir: Path) -> Path:
    path = out_dir / "manifest.csv"
    fields = ["song_id", "artist_id", "source", "path", "encoding", "n_syllables", "n_lines", "key_tonic", "key_mode", "status"]
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(entries)
    return path


def slug(text: str) -> str:
    s = unicodedata.normalize("NFD", text).replace("đ", "d").replace("Đ", "D")
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^A-Za-z0-9]+", "_", s).strip("_").lower() or "unknown"
