"""Bộ dữ liệu 20 bài hát Việt của Kirby & Ladd (ĐH Edinburgh) → bảng chữ.

Nguồn: "Tone-melody correspondence in Vietnamese popular song: supplementary materials", Edinburgh DataShare
https://datashare.ed.ac.uk/handle/10283/2047 (giấy phép CC BY 4.0). Tải `csv.zip`, giải nén, rồi:

    python ml/vn_tone/extract_edinburgh.py --input ml/vn_tone/data/raw/edinburgh --out ml/vn_tone/data/processed_edinburgh
    python ml/vn_tone/train.py --data ml/vn_tone/data/processed_edinburgh

Mỗi file CSV là một bài, một dòng một chữ: `note, step_on, alter_on, octave_on, step_off, alter_off, octave_off, boundary,
duration, verse, syllable, tone`. Lời viết bằng IPA nên thanh lấy từ cột `tone` (1 ngang, 2 huyền, 3 ngã, 4 hỏi, 5 sắc,
6 nặng, theo bảng Chao 33, 32, 3ʔ5, 21, 24, 2ʔ trong script R đi kèm). `*_on` là nốt đầu của chữ, `*_off` là nốt cuối (khác
nhau khi chữ luyến nhiều nốt); `duration` tính theo nốt tròn; `boundary` đúng ở chữ cuối câu. Khoảng cách giữa hai chữ tính
từ nốt cuối chữ trước đến nốt đầu chữ sau, giống bài báo.
"""

from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import vn_common as vc  # noqa: E402

TONE_CODE = {"1": "ngang", "2": "huyen", "3": "nga", "4": "hoi", "5": "sac", "6": "nang"}
STEP = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def midi_of(step: str, alter: str, octave: str) -> int:
    return 12 * (int(float(octave)) + 1) + STEP[step.strip().upper()] + int(float(alter or 0))


def read_song(path: Path) -> list[dict]:
    """Trả về các chữ (đã có pitch, pitch_off, onset_beat, dur_beat, tone, end_line)."""
    out, onset = [], 0.0
    with path.open(encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            tone = TONE_CODE.get(str(r.get("tone", "")).strip())
            if tone is None or not r.get("step_on"):
                continue
            on = midi_of(r["step_on"], r["alter_on"], r["octave_on"])
            off = midi_of(r["step_off"], r["alter_off"], r["octave_off"]) if r.get("step_off") else on
            dur = float(r["duration"]) * 4  # nốt tròn → phách (nốt đen)
            out.append(
                {
                    "syllable": r["syllable"].strip(),
                    "tone": tone,
                    "pitch": on,
                    "pitch_off": off,
                    "onset_beat": onset,
                    "dur_beat": dur,
                    "melisma_notes": 1 if off == on else 2,
                    "end_line": str(r.get("boundary", "")).strip().lower() == "true",
                }
            )
            onset += dur
    return out


def song_rows(path: Path) -> list[dict]:
    sylls = read_song(path)
    if not sylls:
        return []
    key = vc.detect_key([s["pitch"] for s in sylls], [s["dur_beat"] for s in sylls])
    rows, line, idx = [], 0, 0
    for i, s in enumerate(sylls):
        if i > 0:
            if sylls[i - 1]["end_line"]:
                line, idx = line + 1, 0
            else:
                idx += 1
        rows.append(
            {
                "song_id": vc.slug(path.stem),
                # Mỗi bài một nhóm: train.py chia train/test theo nhóm này nên bài trong tập test chưa được học.
                "artist_id": vc.slug(path.stem),
                "source": "edinburgh",
                "line": line,
                "idx_in_line": idx,
                "syllable": s["syllable"],
                "tone": s["tone"],
                "pitch": s["pitch"],
                "onset_beat": round(s["onset_beat"], 4),
                "dur_beat": round(s["dur_beat"], 4),
                "interval_prev": None if idx == 0 else s["pitch"] - sylls[i - 1]["pitch_off"],
                "key_tonic": int(key[0]),
                "key_mode": key[1],
                "melisma_notes": s["melisma_notes"],
            }
        )
    return rows


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", type=Path, required=True, help="thư mục chứa các file CSV (tìm đệ quy)")
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args(argv)

    rows, manifest = [], []
    for path in sorted(args.input.rglob("*.csv")):
        try:
            r = song_rows(path)
            manifest.append(
                {
                    "song_id": vc.slug(path.stem),
                    "artist_id": vc.slug(path.stem),
                    "source": "edinburgh",
                    "path": str(path),
                    "encoding": "utf-8",
                    "n_syllables": len(r),
                    "n_lines": (r[-1]["line"] + 1) if r else 0,
                    "key_tonic": r[0]["key_tonic"] if r else "",
                    "key_mode": r[0]["key_mode"] if r else "",
                    "status": "ok" if r else "không có chữ",
                }
            )
            rows += r
        except (KeyError, ValueError) as e:
            manifest.append({"song_id": vc.slug(path.stem), "path": str(path), "n_syllables": 0, "status": f"sai định dạng: {e}"})
    if not rows:
        raise SystemExit(f"Không đọc được chữ nào trong {args.input}")
    out = vc.write_rows(rows, args.out)
    vc.write_manifest(manifest, args.out)
    print(f"{len(rows)} chữ từ {sum(1 for m in manifest if m['n_syllables'])} bài → {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
