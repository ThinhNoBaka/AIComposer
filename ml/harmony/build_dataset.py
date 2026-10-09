"""Dựng bộ dữ liệu giai điệu → hợp âm theo từng ô nhịp từ POP909.

Với mỗi bài:
  - giọng (nốt chủ, trưởng/thứ) lấy từ key_audio.txt, có thể đổi giọng giữa bài;
  - lưới ô nhịp lấy từ beat_midi.txt (cột 3 = phách mạnh đầu ô nhịp 4/4);
  - hợp âm mỗi ô = hợp âm chiếm nhiều thời gian nhất trong ô (chord_midi.txt),
    quy về bậc 0..6 so với giọng + cờ hợp âm 7. Hợp âm có nốt gốc ngoài thang âm
    (vd. bVII trong giọng trưởng) hoặc N (không hợp âm) thì ghi bậc -1, không dùng để học;
  - giai điệu = track "MELODY", tính histogram 12 lớp cao độ theo giọng (0 = nốt chủ),
    trọng số là trường độ tính bằng phách. Thêm một histogram riêng cho nốt bắt đầu ở
    phách 1 hoặc 3 để tái hiện đúng luật cũ của frontend (nốt phách mạnh nhân đôi).

Kết quả: ml/harmony/data/pop909_bars.npz

    python ml/harmony/build_dataset.py
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pretty_midi

HERE = Path(__file__).resolve().parent
DEFAULT_RAW = HERE / "data" / "raw"
DEFAULT_OUT = HERE / "data" / "pop909_bars.npz"

NOTE_PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
SCALES = {
    "major": (0, 2, 4, 5, 7, 9, 11),
    "minor": (0, 2, 3, 5, 7, 8, 10),  # thứ tự nhiên, giống frontend
}
MODES = ("major", "minor")
SEVENTH_QUALITIES = ("7", "maj7", "min7", "hdim7", "dim7", "minmaj7", "sus4(b7)", "9", "min9", "maj9", "11", "13")


def name_to_pc(name: str) -> int:
    """'C#', 'Bb', 'Gb' → 0..11."""
    pc = NOTE_PC[name[0].upper()]
    for acc in name[1:]:
        if acc == "#":
            pc += 1
        elif acc == "b":
            pc -= 1
    return pc % 12


@dataclass
class ChordLabel:
    start: float
    end: float
    root: int | None  # None = N (không hợp âm)
    seventh: bool


def parse_chord_label(label: str) -> tuple[int | None, bool]:
    """'F#:maj7/5' → (6, True). 'N' hoặc 'X' → (None, False)."""
    label = label.strip()
    if ":" not in label:
        return None, False
    root, quality = label.split(":", 1)
    quality = quality.split("/", 1)[0]
    return name_to_pc(root), quality in SEVENTH_QUALITIES or quality.startswith(("7", "maj7", "min7"))


def read_chords(path: Path) -> list[ChordLabel]:
    out = []
    for line in path.read_text().splitlines():
        parts = line.split("\t") if "\t" in line else line.split()
        if len(parts) < 3:
            continue
        root, sev = parse_chord_label(parts[2])
        out.append(ChordLabel(float(parts[0]), float(parts[1]), root, sev))
    return out


def read_keys(path: Path) -> list[tuple[float, float, int, str]]:
    """Các đoạn giọng: (bắt đầu, kết thúc, nốt chủ, 'major'|'minor')."""
    out = []
    for line in path.read_text().splitlines():
        parts = line.split("\t") if "\t" in line else line.split()
        if len(parts) < 3 or ":" not in parts[2]:
            continue
        tonic, q = parts[2].split(":", 1)
        mode = "minor" if q.startswith("min") else "major"
        out.append((float(parts[0]), float(parts[1]), name_to_pc(tonic), mode))
    return out


def read_downbeats(path: Path) -> np.ndarray:
    """Thời điểm đầu các ô nhịp 4/4 (cột 3 của beat_midi.txt bằng 1)."""
    times = []
    for line in path.read_text().splitlines():
        parts = line.split()
        if len(parts) >= 3 and float(parts[2]) >= 0.5:
            times.append(float(parts[0]))
    return np.asarray(times, dtype=float)


def key_at(keys: list[tuple[float, float, int, str]], t: float) -> tuple[int, str]:
    for s, e, tonic, mode in keys:
        if s <= t < e:
            return tonic, mode
    # Ngoài mọi đoạn (đầu/cuối bài): lấy đoạn gần nhất.
    best = min(keys, key=lambda k: min(abs(t - k[0]), abs(t - k[1])))
    return best[2], best[3]


def melody_notes(midi_path: Path) -> list[tuple[float, float, int]]:
    pm = pretty_midi.PrettyMIDI(str(midi_path))
    for inst in pm.instruments:
        if inst.name.strip().upper() == "MELODY":
            return [(n.start, n.end, n.pitch) for n in inst.notes]
    return []


def overlap(a0: float, a1: float, b0: float, b1: float) -> float:
    return max(0.0, min(a1, b1) - max(a0, b0))


def process_song(folder: Path) -> dict | None:
    """Trả về các mảng theo ô nhịp của một bài, hoặc None nếu thiếu dữ liệu."""
    sid = folder.name
    midi = folder / f"{sid}.mid"
    need = [midi, folder / "chord_midi.txt", folder / "key_audio.txt", folder / "beat_midi.txt"]
    if not all(p.exists() for p in need):
        return None
    keys = read_keys(folder / "key_audio.txt")
    downbeats = read_downbeats(folder / "beat_midi.txt")
    if not keys or len(downbeats) < 2:
        return None
    chords = read_chords(folder / "chord_midi.txt")
    notes = melody_notes(midi)
    if not notes:
        return None

    bar_len = float(np.median(np.diff(downbeats)))
    edges = np.append(downbeats, downbeats[-1] + bar_len)
    n = len(downbeats)
    degree = np.full(n, -1, dtype=np.int8)
    seventh = np.zeros(n, dtype=np.int8)
    mode = np.zeros(n, dtype=np.int8)
    tonic = np.zeros(n, dtype=np.int8)
    hist = np.zeros((n, 12), dtype=np.float32)
    strong = np.zeros((n, 12), dtype=np.float32)
    stats = {"no_chord": 0, "chromatic": 0}
    n_start = np.array([x[0] for x in notes])
    n_end = np.array([x[1] for x in notes])
    n_pitch = np.array([x[2] for x in notes], dtype=np.int64)

    for b in range(n):
        s, e = edges[b], edges[b + 1]
        beat = (e - s) / 4
        t, m = key_at(keys, (s + e) / 2)
        tonic[b] = t
        mode[b] = MODES.index(m)

        # Hợp âm chiếm lâu nhất trong ô (tính cả N).
        best, best_len = None, 0.0
        for c in chords:
            ov = overlap(s, e, c.start, c.end)
            if ov > best_len:
                best, best_len = c, ov
        if best is None or best.root is None:
            stats["no_chord"] += 1
        else:
            rel = (best.root - t) % 12
            scale = SCALES[m]
            if rel in scale:
                degree[b] = scale.index(rel)
                seventh[b] = int(best.seventh)
            else:
                stats["chromatic"] += 1

        ov = np.clip(np.minimum(n_end, e) - np.maximum(n_start, s), 0, None) / beat
        hit = ov > 0
        if hit.any():
            pcs = (n_pitch[hit] - t) % 12
            np.add.at(hist[b], pcs, ov[hit])
            # Nốt bắt đầu đúng phách 1 hoặc 3 (sai lệch dưới 1/8 phách).
            pos = (n_start[hit] - s) / beat
            on_strong = (n_start[hit] >= s - 1e-6) & (n_start[hit] < e) & (np.minimum(np.abs(pos), np.abs(pos - 2)) < 0.125)
            np.add.at(strong[b], pcs[on_strong], ov[hit][on_strong])

    return {
        "song": sid,
        "degree": degree,
        "seventh": seventh,
        "mode": mode,
        "tonic": tonic,
        "hist": hist,
        "strong": strong,
        "stats": stats,
    }


def build(raw: Path, out: Path, limit: int | None = None, verbose: bool = True) -> dict:
    folders = sorted(p for p in raw.iterdir() if p.is_dir())
    if limit:
        folders = folders[:limit]
    songs = []
    skipped = []
    for f in folders:
        try:
            r = process_song(f)
        except Exception as e:  # noqa: BLE001 - file hỏng thì bỏ qua, không dừng cả bộ
            if verbose:
                print(f"  {f.name}: lỗi {e}", file=sys.stderr)
            r = None
        if r is None:
            skipped.append(f.name)
        else:
            songs.append(r)
    if not songs:
        raise SystemExit("Không có bài nào dùng được")

    lengths = np.array([len(s["degree"]) for s in songs], dtype=np.int32)
    data = {
        "song_ids": np.array([s["song"] for s in songs]),
        "offsets": np.concatenate([[0], np.cumsum(lengths)]).astype(np.int64),
        "degree": np.concatenate([s["degree"] for s in songs]),
        "seventh": np.concatenate([s["seventh"] for s in songs]),
        "mode": np.concatenate([s["mode"] for s in songs]),
        "tonic": np.concatenate([s["tonic"] for s in songs]),
        "hist": np.concatenate([s["hist"] for s in songs]),
        "strong": np.concatenate([s["strong"] for s in songs]),
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(out, **data)

    summary = {
        "songs": len(songs),
        "skipped": len(skipped),
        "bars": int(lengths.sum()),
        "labelled": int((data["degree"] >= 0).sum()),
        "no_chord": sum(s["stats"]["no_chord"] for s in songs),
        "chromatic": sum(s["stats"]["chromatic"] for s in songs),
        "with_melody": int((data["hist"].sum(1) > 0).sum()),
    }
    if verbose:
        print(
            f"{summary['songs']} bài ({summary['skipped']} bỏ qua), {summary['bars']} ô nhịp; "
            f"{summary['labelled']} ô có bậc hợp âm, {summary['no_chord']} ô N, "
            f"{summary['chromatic']} ô hợp âm ngoài thang âm; {summary['with_melody']} ô có giai điệu"
        )
        print(f"Đã ghi {out}")
    return summary


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raw", type=Path, default=DEFAULT_RAW)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args(argv)
    build(args.raw, args.out, args.limit)
    return 0


if __name__ == "__main__":
    sys.exit(main())
