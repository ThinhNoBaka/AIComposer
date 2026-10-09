"""Dò cao độ cơ bản (F0) bằng pYIN."""

from __future__ import annotations

from dataclasses import dataclass

import librosa
import numpy as np

HOP = 160  # 10 ms ở 16 kHz
FRAME = 1024  # 64 ms: đủ dài cho giọng trầm


@dataclass
class PitchTrack:
    times: np.ndarray  # giây
    midi: np.ndarray  # cao độ MIDI dạng số thực, NaN ở khung không có giọng
    voiced_prob: np.ndarray
    rms: np.ndarray
    sr: int
    hop: int


def track_pitch(y: np.ndarray, sr: int, fmin: float = 65.0, fmax: float = 1050.0) -> PitchTrack:
    f0, _voiced_flag, voiced_prob = librosa.pyin(
        y, fmin=fmin, fmax=fmax, sr=sr, frame_length=FRAME, hop_length=HOP
    )
    rms = librosa.feature.rms(y=y, frame_length=FRAME, hop_length=HOP)[0]
    n = min(len(f0), len(rms))
    f0, voiced_prob, rms = f0[:n], voiced_prob[:n], rms[:n]
    with np.errstate(divide="ignore", invalid="ignore"):
        midi = 69.0 + 12.0 * np.log2(f0 / 440.0)
    times = librosa.frames_to_time(np.arange(n), sr=sr, hop_length=HOP)
    return PitchTrack(times=times, midi=midi, voiced_prob=np.nan_to_num(voiced_prob), rms=rms, sr=sr, hop=HOP)
