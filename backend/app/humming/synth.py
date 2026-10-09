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


def synth_hum_natural(
    notes: list[tuple[float, float, float]],
    sr: int = 16000,
    tuning_cents: float = 45.0,
    drift_cents: float = -60.0,
    legato: float = 1.0,
    seed: int = 0,
) -> np.ndarray:
    """Tiếng ngân giống người thật hơn synth_hum: lệch chuẩn La 440 cả bài, trôi dần cao độ, trượt vào nốt,
    luyến liền giữa các nốt (không ngắt tiếng), nốt cùng cao độ chỉ tụt âm lượng, âm sắc giọng mũi "mm"."""
    from scipy.signal import lfilter

    rng = np.random.default_rng(seed)
    total = max(off for _, off, _ in notes) + 0.5
    n = int(total * sr)
    f0 = np.full(n, np.nan)
    amp = np.zeros(n)
    for i, (on, off, midi) in enumerate(notes):
        cont = i + 1 < len(notes) and rng.random() < legato and abs(notes[i + 1][0] - off) < 0.1
        same = cont and notes[i + 1][2] == midi
        a, b = int(on * sr), int((notes[i + 1][0] if cont else off) * sr)
        t = np.arange(b - a) / sr
        cents = tuning_cents + drift_cents * on / total + rng.normal(0, 12)
        scoop = -rng.uniform(30, 100) * np.exp(-t / 0.05)
        vib = 30 * np.sin(2 * np.pi * 5.5 * t) * np.clip((t - 0.25) / 0.2, 0, 1)
        f0[a:b] = midi + (cents + scoop + vib) / 100
        env = np.minimum(1, t / 0.04) * (1.0 if cont and not same else np.minimum(1, (t[-1] - t) / 0.05))
        amp[a:b] = np.maximum(env, 0.15) if same else env
        if cont and not same:
            g = int(0.08 * sr)
            s = max(a, b - g)
            target = notes[i + 1][2] + (tuning_cents + drift_cents * notes[i + 1][0] / total) / 100
            f0[s:b] = np.linspace(f0[s], target, b - s)
    voiced = np.isfinite(f0)
    hz = 440.0 * 2 ** ((np.nan_to_num(f0, nan=60.0) - 69) / 12)
    phase = 2 * np.pi * np.cumsum(hz) / sr
    y = sum((0.7**k) * np.sin((k + 1) * phase) for k in range(12)) * amp * voiced

    def formant(x: np.ndarray, f: float, bw: float) -> np.ndarray:
        r = np.exp(-np.pi * bw / sr)
        return lfilter([1 - r], [1, -2 * r * np.cos(2 * np.pi * f / sr), r * r], x)

    y = formant(y, 280, 90) + 0.5 * formant(y, 900, 150) + 0.2 * formant(y, 2400, 250)
    y = y / (np.abs(y).max() + 1e-9) + 0.02 * rng.standard_normal(n)
    return y.astype(np.float32)
