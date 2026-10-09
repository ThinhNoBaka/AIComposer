"""Đánh giá pipeline humming → nốt trên dataset có nhãn MIDI (vd. HumTrans).

Cách dùng:
    python -m scripts.eval_humtrans --data /duong/dan/HumTrans --limit 200
    python -m scripts.eval_humtrans --data ... --grid          # dò tham số tách nốt
    python -m scripts.eval_humtrans --synthetic 40              # chạy thử không cần dataset

Ghép file audio và MIDI theo tên (cùng stem), tìm đệ quy trong --data (và --midi-dir nếu có).
Chỉ số chính: note F1 theo onset (±50 ms) và cao độ (±50 cent) của mir_eval.
"""

from __future__ import annotations

import argparse
import csv
import itertools
import statistics
import sys
import time
from dataclasses import asdict, replace
from pathlib import Path

import numpy as np

from app.humming.audio import TARGET_SR
from app.humming.evaluate import note_scores
from app.humming.notes import SegmentParams, segment_notes
from app.humming.pitch import track_pitch

AUDIO_EXT = {".wav", ".flac", ".mp3", ".ogg"}


def load_reference(midi_path: Path) -> list[tuple[float, float, float]]:
    import pretty_midi

    pm = pretty_midi.PrettyMIDI(str(midi_path))
    notes = [n for inst in pm.instruments if not inst.is_drum for n in inst.notes]
    notes.sort(key=lambda n: n.start)
    return [(n.start, n.end, float(n.pitch)) for n in notes]


def load_wav(path: Path) -> np.ndarray:
    import librosa

    y, _ = librosa.load(str(path), sr=TARGET_SR, mono=True)
    return y.astype(np.float32)


def fold_octave(ref, est):
    """Người ngân thường lệch cả quãng tám so với nhãn: dịch kết quả theo bội 12 cho khớp trung vị."""
    if not ref or not est:
        return est
    shift = round((np.median([p for *_, p in ref]) - np.median([n.pitch for n in est])) / 12) * 12
    return [(n.onset, n.offset, n.pitch + shift) for n in est]


def find_pairs(data: Path, midi_dir: Path | None) -> list[tuple[Path, Path]]:
    midis = {p.stem: p for p in (midi_dir or data).rglob("*") if p.suffix.lower() in {".mid", ".midi"}}
    pairs = []
    for a in sorted(data.rglob("*")):
        if a.suffix.lower() in AUDIO_EXT and a.stem in midis:
            pairs.append((a, midis[a.stem]))
    return pairs


def synthetic_pairs(n: int, seed: int = 0):
    """Sinh dữ liệu giả lập (giai điệu ngẫu nhiên trong Đô trưởng) để kiểm tra script khi chưa có dataset."""
    from app.humming.synth import synth_hum

    rng = np.random.default_rng(seed)
    scale = [60, 62, 64, 65, 67, 69, 71, 72]
    for i in range(n):
        bpm = rng.uniform(70, 130)
        t, ref = 0.3, []
        for _ in range(rng.integers(8, 16)):
            beats = rng.choice([0.5, 1, 1, 2])
            dur = beats * 60 / bpm
            ref.append((t, t + dur - 0.05, float(rng.choice(scale))))
            t += dur
        y = synth_hum(ref, TARGET_SR, vibrato_cents=rng.uniform(10, 60), detune_cents=rng.uniform(-40, 40), noise=rng.uniform(0.005, 0.05), seed=i)
        yield f"synthetic_{i:03d}", y, ref


def param_grid() -> list[SegmentParams]:
    base = SegmentParams()
    grid = []
    for vt, md, pj, ed in itertools.product([0.15, 0.25, 0.4], [0.06, 0.08, 0.12], [0.6, 0.75, 1.0], [0.35, 0.45, 0.6]):
        grid.append(replace(base, voiced_threshold=vt, min_note_sec=md, pitch_jump=pj, energy_dip=ed))
    return grid


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, help="thư mục dataset (audio + MIDI)")
    ap.add_argument("--midi-dir", type=Path, default=None)
    ap.add_argument("--synthetic", type=int, default=0, help="dùng N mẫu giả lập thay cho dataset")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--grid", action="store_true", help="dò lưới tham số tách nốt")
    ap.add_argument("--out", type=Path, default=Path("reports/humming_eval.csv"))
    args = ap.parse_args(argv)

    if args.synthetic:
        items = list(synthetic_pairs(args.synthetic))
    elif args.data:
        pairs = find_pairs(args.data, args.midi_dir)
        if args.limit:
            pairs = pairs[: args.limit]
        if not pairs:
            print("Không tìm thấy cặp audio + MIDI cùng tên trong", args.data, file=sys.stderr)
            return 1
        items = ((a.stem, load_wav(a), load_reference(m)) for a, m in pairs)
    else:
        ap.error("cần --data hoặc --synthetic")

    params_list = param_grid() if args.grid else [SegmentParams()]
    rows = []
    t0 = time.time()
    for k, (name, y, ref) in enumerate(items):
        track = track_pitch(y, TARGET_SR)  # pYIN chạy một lần cho mỗi file, tham số tách nốt dò sau
        for pi, params in enumerate(params_list):
            est = segment_notes(track, params)
            raw = note_scores(ref, est)
            folded = note_scores(ref, fold_octave(ref, est))
            rows.append({"file": name, "param_id": pi, **asdict(params), **{f"raw_{k2}": v for k2, v in raw.items()}, **{f"oct_{k2}": v for k2, v in folded.items()}})
        if (k + 1) % 10 == 0:
            print(f"  đã xử lý {k + 1} file ({time.time() - t0:.0f}s)")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    print(f"\nĐã ghi {len(rows)} dòng vào {args.out}")
    summary = []
    for pi, params in enumerate(params_list):
        sub = [r for r in rows if r["param_id"] == pi]
        summary.append((statistics.mean(r["oct_f1"] for r in sub), statistics.mean(r["raw_f1"] for r in sub), statistics.mean(r["oct_f1_with_offset"] for r in sub), params))
    summary.sort(key=lambda s: -s[0])
    print("\nTop tham số (F1 bỏ qua quãng tám | F1 thô | F1 có offset):")
    for f_oct, f_raw, f_off, p in summary[:5]:
        print(f"  {f_oct:.3f} | {f_raw:.3f} | {f_off:.3f}  voiced={p.voiced_threshold} min_dur={p.min_note_sec} jump={p.pitch_jump} dip={p.energy_dip}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
