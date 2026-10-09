"""Tính đường cao độ đích cho giọng hát và áp lên bản thu (kiểu "auto-tune").

Các bước:
1. `analyze`: dò F0 bằng pYIN trên bản hạ về 16 kHz (nhanh hơn nhiều so với 44.1 kHz), khung 10 ms.
2. `correction_curve`: với mỗi đoạn có giọng, chọn nốt đích từng khung (theo giai điệu, theo thang âm hoặc theo
   12 nốt), tính độ lệch, nhân với `strength`, làm mượt theo `retune_speed_ms`.
3. `psola_shift` dời cao độ theo đường đã tính.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from math import gcd

import librosa
import numpy as np
from scipy.ndimage import gaussian_filter1d
from scipy.signal import lfilter, resample_poly

from ..humming.keys import SCALES
from .psola import psola_shift, voiced_runs

ANALYSIS_SR = 16000
HOP = 160  # 10 ms
FRAME = 1024
HOP_S = HOP / ANALYSIS_SR
FMIN, FMAX = 65.0, 1050.0
MIN_RUN_FRAMES = 4  # đoạn có giọng ngắn hơn 40 ms coi như không có giọng
VIBRATO_SIGMA_S = 0.06  # làm mượt Gauss sigma 60 ms: giữ phần chậm (<~2 Hz), bỏ rung 4–8 Hz
HYSTERESIS = 0.3  # nửa cung: chỉ đổi nốt đích khi nốt mới gần hơn hẳn chừng này
MODES = ("melody", "scale", "chromatic")


@dataclass
class Analysis:
    midi: np.ndarray  # cao độ MIDI số thực mỗi khung, NaN ở khung không có giọng
    hop_s: float = HOP_S

    @property
    def voiced(self) -> np.ndarray:
        return np.isfinite(self.midi)

    def to_json(self) -> dict:
        return {"hop_s": self.hop_s, "midi": [None if not np.isfinite(m) else round(float(m), 3) for m in self.midi]}

    @classmethod
    def from_json(cls, d: dict) -> "Analysis":
        return cls(midi=np.array([np.nan if m is None else m for m in d["midi"]], dtype=np.float64), hop_s=float(d["hop_s"]))


@dataclass
class CorrectionParams:
    strength: float = 1.0  # 0..1: phần độ lệch được bỏ đi
    mode: str = "scale"  # melody | scale | chromatic
    retune_speed_ms: float = 0.0  # 0 = bám nốt tức thì
    keep_vibrato: bool = True
    tonic: int | None = None  # 0..11
    scale: str | None = None  # khoá trong SCALES
    notes: list[dict] = field(default_factory=list)  # [{pitch, start_s, end_s}] tính theo giây của bản thu


def to_analysis_sr(y: np.ndarray, sr: int) -> np.ndarray:
    if sr == ANALYSIS_SR:
        return np.asarray(y, dtype=np.float32)
    g = gcd(sr, ANALYSIS_SR)
    return resample_poly(y, ANALYSIS_SR // g, sr // g).astype(np.float32)


def analyze(y: np.ndarray, sr: int) -> Analysis:
    ya = to_analysis_sr(y, sr)
    if len(ya) < FRAME or float(np.max(np.abs(ya))) < 1e-4:
        return Analysis(midi=np.full(max(1, len(ya) // HOP + 1), np.nan))
    f0, vflag, _ = librosa.pyin(ya, fmin=FMIN, fmax=FMAX, sr=ANALYSIS_SR, frame_length=FRAME, hop_length=HOP)
    with np.errstate(divide="ignore", invalid="ignore"):
        midi = 69.0 + 12.0 * np.log2(f0 / 440.0)
    midi[~(vflag & np.isfinite(midi))] = np.nan
    for a, b in voiced_runs(np.isfinite(midi)):
        if b - a < MIN_RUN_FRAMES:
            midi[a:b] = np.nan
    return Analysis(midi=midi)


def _nearest(p: float, pcs: list[int]) -> int:
    return min((pc + 12 * round((p - pc) / 12) for pc in pcs), key=lambda n: (abs(p - n), n))


def _melody_frames(n: int, hop_s: float, params: CorrectionParams) -> np.ndarray:
    """Lớp cao độ (0..11) của nốt giai điệu đang vang ở mỗi khung, -1 nếu không có nốt."""
    out = np.full(n, -1, dtype=np.int64)
    if params.mode != "melody":
        return out
    t = np.arange(n) * hop_s
    for nt in sorted(params.notes, key=lambda x: x["start_s"]):
        out[(t >= nt["start_s"]) & (t < nt["end_s"])] = int(round(nt["pitch"])) % 12
    return out


def _fallback_pcs(params: CorrectionParams) -> list[int]:
    """Thang dùng khi không có nốt giai điệu: thang của giọng nếu có, không thì cả 12 nốt."""
    if params.mode in ("melody", "scale") and params.tonic is not None and params.scale in SCALES:
        return [(params.tonic + s) % 12 for s in SCALES[params.scale]]
    return list(range(12))


def _retune(x: np.ndarray, tau_s: float, hop_s: float) -> np.ndarray:
    """Tốc độ kéo về nốt, giống "retune speed" của Auto-Tune: lọc mũ một cực (nhân quả) bắt đầu từ 0 ở đầu
    mỗi đoạn có giọng, hằng thời gian `tau_s` (sau tau_s đạt ~63% độ chỉnh). Đầu câu vì vậy còn nét vào nốt tự
    nhiên; khi đổi nốt, cao độ trượt sang nốt mới thay vì nhảy bậc. Phần rung nhanh hơn 1/tau bị lọc bớt nên
    retune chậm cũng giữ được rung giọng."""
    if tau_s <= 0 or len(x) == 0:
        return x
    alpha = 1.0 - np.exp(-hop_s / tau_s)
    return lfilter([alpha], [1.0, alpha - 1.0], x)


def correction_curve(an: Analysis, params: CorrectionParams) -> tuple[np.ndarray, np.ndarray]:
    """Trả về (nốt đích, độ chỉnh tính bằng nửa cung) cho từng khung; khung không có giọng là NaN / 0."""
    midi = an.midi
    n = len(midi)
    target = np.full(n, np.nan)
    corr = np.zeros(n)
    strength = float(np.clip(params.strength, 0.0, 1.0))
    sigma = VIBRATO_SIGMA_S / an.hop_s
    mel = _melody_frames(n, an.hop_s, params)
    fallback = _fallback_pcs(params)
    for a, b in voiced_runs(np.isfinite(midi)):
        m = midi[a:b]
        slow = gaussian_filter1d(m, sigma, mode="nearest") if b - a > 1 else m.copy()
        notes = np.empty(b - a)
        cur: int | None = None
        for i, p in enumerate(slow):
            pcs = [int(mel[a + i])] if mel[a + i] >= 0 else fallback
            cand = _nearest(float(p), pcs)
            if cur is None or cur % 12 not in pcs or abs(p - cand) + HYSTERESIS < abs(p - cur):
                cur = cand
            notes[i] = cur
        err = notes - (slow if params.keep_vibrato else m)
        c = _retune(strength * err, params.retune_speed_ms / 1000.0, an.hop_s)
        target[a:b] = notes
        corr[a:b] = c
    return target, corr


def apply_correction(y: np.ndarray, sr: int, an: Analysis, corr: np.ndarray) -> np.ndarray:
    f0 = 440.0 * 2 ** ((an.midi - 69.0) / 12.0)
    return psola_shift(y, sr, f0, an.voiced, f0 * 2 ** (corr / 12.0), an.hop_s)


def correct_vocal(y: np.ndarray, sr: int, params: CorrectionParams, an: Analysis | None = None) -> tuple[np.ndarray, Analysis, np.ndarray]:
    """Chỉnh cao độ cả bản thu. Trả về (audio đã chỉnh, phân tích F0, cao độ MIDI sau chỉnh mỗi khung).

    strength = 0 trả lại đúng mảng đầu vào (không qua PSOLA).
    """
    if params.mode not in MODES:
        raise ValueError(f"mode phải là một trong {MODES}")
    an = an or analyze(y, sr)
    if params.strength <= 0:
        return y, an, an.midi.copy()
    _target, corr = correction_curve(an, params)
    out = apply_correction(y, sr, an, corr)
    np.clip(out, -1.0, 1.0, out=out)
    return out, an, an.midi + corr
