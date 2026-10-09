"""Ước lượng giọng (key) bằng thuật toán Krumhansl–Schmuckler và làm tròn nốt vào thang âm."""

from __future__ import annotations

import numpy as np

# Hồ sơ Krumhansl–Kessler (1982)
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

SCALES = {
    "major": [0, 2, 4, 5, 7, 9, 11],
    "minor": [0, 2, 3, 5, 7, 8, 10],
    "dorian": [0, 2, 3, 5, 7, 9, 10],
    "majorPentatonic": [0, 2, 4, 7, 9],
    "minorPentatonic": [0, 3, 5, 7, 10],
}


def pitch_class_histogram(pitches: list[float], weights: list[float]) -> np.ndarray:
    hist = np.zeros(12)
    for p, w in zip(pitches, weights):
        hist[int(round(p)) % 12] += w
    return hist


def detect_key(pitches: list[float], weights: list[float]) -> tuple[int, str, float]:
    """Trả về (nốt chủ 0..11, 'major'|'minor', độ tin cậy = hệ số tương quan tốt nhất)."""
    hist = pitch_class_histogram(pitches, weights)
    if hist.sum() == 0:
        return 0, "major", 0.0
    best = (0, "major", -2.0)
    for tonic in range(12):
        for mode, prof in (("major", MAJOR_PROFILE), ("minor", MINOR_PROFILE)):
            r = float(np.corrcoef(hist, np.roll(prof, tonic))[0, 1])
            if np.isnan(r):
                continue
            if r > best[2]:
                best = (tonic, mode, r)
    return best


def snap_to_scale(midi: int, tonic: int, mode: str) -> int:
    """Làm tròn về nốt gần nhất trong thang (hoà thì lấy nốt thấp), giống hàm snapToScale phía web."""
    scale = SCALES[mode]
    rel = midi - tonic
    octave = rel // 12
    within = rel - octave * 12
    best = min(scale + [12], key=lambda s: (abs(within - s), s))
    return tonic + octave * 12 + best
