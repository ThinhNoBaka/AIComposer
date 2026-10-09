"""Tạo tiếng ngân nga giả lập từ danh sách nốt, dùng cho test và demo khi chưa có dataset."""

from __future__ import annotations

import numpy as np


def synth_hum(
    notes: list[tuple[float, float, float]],
    sr: int = 16000,
    vibrato_cents: float = 25.0,
    noise: float = 0.01,
    detune_cents: float = 0.0,
    seed: int = 0,
    tail: float = 0.5,
) -> np.ndarray:
    """notes = [(onset_giây, offset_giây, midi)]. Có hài âm, rung (vibrato), lệch cao độ và tiếng thở."""
    rng = np.random.default_rng(seed)
    total = max(off for _, off, _ in notes) + tail
    y = np.zeros(int(total * sr), dtype=np.float64)
    for on, off, midi in notes:
        n = int((off - on) * sr)
        t = np.arange(n) / sr
        drift = detune_cents + rng.normal(0, 8)
        cents = drift + vibrato_cents * np.sin(2 * np.pi * 5.5 * t) * np.clip(t / 0.25, 0, 1)
        f = 440.0 * 2 ** ((midi - 69 + cents / 100.0) / 12.0)
        phase = 2 * np.pi * np.cumsum(f) / sr
        tone = np.sin(phase) + 0.5 * np.sin(2 * phase) + 0.25 * np.sin(3 * phase) + 0.1 * np.sin(4 * phase)
        env = np.minimum(1, t / 0.03) * np.minimum(1, (n / sr - t) / 0.05)
        start = int(on * sr)
        y[start : start + n] += 0.25 * tone * env
    y += noise * rng.standard_normal(len(y))
    return y.astype(np.float32)


def to_wav_bytes(y: np.ndarray, sr: int = 16000) -> bytes:
    import io

    import soundfile as sf

    buf = io.BytesIO()
    sf.write(buf, y, sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()
