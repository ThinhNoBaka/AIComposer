"""Dò cao độ cơ bản (F0) bằng pYIN."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

import librosa
import numpy as np

HOP = 160  # 10 ms ở 16 kHz
FRAME = 1024  # 64 ms: đủ dài cho giọng trầm
# Bản thu dài được xử lý từng đoạn 10 s (thêm 0,5 s mỗi bên cho liền mạch) để bộ nhớ không tăng theo độ dài:
# pYIN cả bản 5 phút một lần tốn hơn 1 GB, máy chủ miễn phí chỉ có 512 MB.
CHUNK_FRAMES = 1000
PAD_FRAMES = 50


@dataclass
class PitchTrack:
    times: np.ndarray  # giây
    midi: np.ndarray  # cao độ MIDI dạng số thực, NaN ở khung không có giọng
    voiced_prob: np.ndarray
    rms: np.ndarray
    sr: int
    hop: int


def framewise(
    y: np.ndarray, fn: Callable[[np.ndarray], np.ndarray], hop: int = HOP, progress: Callable[[float], None] | None = None
) -> np.ndarray:
    """Gọi `fn` (trả mảng [..., số khung], khung căn giữa, bước `hop`) trên từng đoạn rồi nối lại theo khung.

    Bản ngắn gọi thẳng một lần. Mỗi đoạn lấy thêm PAD_FRAMES khung hai bên rồi bỏ đi, nên khung giữ lại
    nhìn thấy đúng phần audio như khi chạy cả bản (khác biệt chỉ còn ở việc làm mượt Viterbi của pYIN, rất nhỏ).
    """
    n_total = 1 + len(y) // hop
    if n_total <= CHUNK_FRAMES + 2 * PAD_FRAMES:
        return fn(y)
    out: np.ndarray | None = None
    for f0 in range(0, n_total, CHUNK_FRAMES):
        f1 = min(n_total, f0 + CHUNK_FRAMES)
        s = max(0, f0 - PAD_FRAMES) * hop
        e = min(len(y), (f1 + PAD_FRAMES) * hop)
        off = f0 - s // hop
        part = fn(y[s:e])[..., off : off + (f1 - f0)]
        if out is None:  # cấp sẵn cả mảng kết quả, không giữ danh sách các đoạn rồi nối (tốn gấp đôi bộ nhớ)
            out = np.empty(part.shape[:-1] + (n_total,), dtype=part.dtype)
        out[..., f0:f1] = part
        if progress:
            progress(f1 / n_total)
    assert out is not None
    return out


def track_pitch(
    y: np.ndarray, sr: int, fmin: float = 65.0, fmax: float = 1050.0, progress: Callable[[float], None] | None = None
) -> PitchTrack:
    def one(seg: np.ndarray) -> np.ndarray:
        f0, _voiced, prob = librosa.pyin(seg, fmin=fmin, fmax=fmax, sr=sr, frame_length=FRAME, hop_length=HOP)
        rms = librosa.feature.rms(y=seg, frame_length=FRAME, hop_length=HOP)[0]
        n = min(len(f0), len(rms))
        return np.stack([f0[:n], prob[:n], rms[:n]])

    f0, voiced_prob, rms = framewise(y, one, progress=progress)
    n = len(f0)
    with np.errstate(divide="ignore", invalid="ignore"):
        midi = 69.0 + 12.0 * np.log2(f0 / 440.0)
    times = librosa.frames_to_time(np.arange(n), sr=sr, hop_length=HOP)
    return PitchTrack(times=times, midi=midi, voiced_prob=np.nan_to_num(voiced_prob), rms=rms, sr=sr, hop=HOP)
