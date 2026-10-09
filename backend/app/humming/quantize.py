"""Lượng tử nốt theo lưới nhịp (bước 1/16) và đặt vào khoảng giọng của giai điệu."""

from __future__ import annotations

import numpy as np

from .notes import NoteEvent

STEPS_PER_BAR = 16
MELODY_CENTER = 69  # La 4, giữa khoảng Đô 4..Sol 5 của web


def estimate_bpm(notes: list[NoteEvent], lo: float = 60, hi: float = 160) -> float:
    """Ước lượng tempo từ khoảng cách giữa các onset (IOI): chọn tempo làm onset rơi đúng lưới 1/8 nhiều nhất."""
    if len(notes) < 3:
        return 100.0
    onsets = np.array([n.onset for n in notes])
    rel_sec = onsets - onsets[0]

    def misfit(grid_sec: float) -> float:
        r = rel_sec / grid_sec
        return float(np.mean(np.abs(r - np.round(r))))

    # Điểm = độ lệch so với lưới móc đơn + một phần độ lệch so với lưới phách (ưu tiên nhịp đơn giản)
    # + một chút ưu tiên tempo gần 100 BPM. Tempo nhân đôi/chia đôi vốn mơ hồ nên người dùng có thể nhập tay.
    def score(bpm: float) -> float:
        beat = 60.0 / bpm
        return misfit(beat / 2) + 0.25 * misfit(beat) + 0.05 * abs(np.log2(bpm / 100.0))

    return float(min(np.arange(lo, hi + 0.1, 1.0), key=score))


def octave_shift(pitches: list[int]) -> int:
    """Số nửa cung (bội của 12) đưa trung vị cao độ về gần giữa khoảng giai điệu."""
    if not pitches:
        return 0
    med = float(np.median(pitches))
    return int(round((MELODY_CENTER - med) / 12.0)) * 12


def quantize(notes: list[NoteEvent], bpm: float, grid_steps: int = 1) -> list[dict]:
    """Đổi giây → bước. Nốt đầu tiên rơi vào bước 0. Nốt chồng nhau thì cắt nốt trước."""
    if not notes:
        return []
    step_sec = 60.0 / bpm / 4
    t0 = notes[0].onset
    out: list[dict] = []
    for n in notes:
        start = int(round((n.onset - t0) / step_sec / grid_steps)) * grid_steps
        end = int(round((n.offset - t0) / step_sec / grid_steps)) * grid_steps
        dur = max(grid_steps, end - start)
        if out and start <= out[-1]["start"]:
            # Hai nốt rơi cùng một ô lưới: giữ nốt dài hơn.
            if dur > out[-1]["dur"]:
                out[-1] = {"pitch": n.midi, "start": out[-1]["start"], "dur": dur, "energy": n.energy}
            continue
        if out and out[-1]["start"] + out[-1]["dur"] > start:
            out[-1]["dur"] = start - out[-1]["start"]
        out.append({"pitch": n.midi, "start": start, "dur": dur, "energy": n.energy})
    return out
