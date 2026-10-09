"""Pipeline đầy đủ: audio ngân nga → nốt → giọng → lưới nhịp → giai điệu cho web."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import asdict, dataclass

import numpy as np

from ..config import HUM_MAX_MINUTES
from .audio import TARGET_SR, load_audio, load_audio_file
from .keys import detect_key, snap_to_scale
from .notes import NoteEvent, SegmentParams, segment_notes
from .pitch import track_pitch
from .quantize import STEPS_PER_BAR, estimate_bpm, octave_shift, quantize
from .onset_model import apply_onset_model
from .tuning import retune

MAX_SECONDS = HUM_MAX_MINUTES * 60


@dataclass
class TranscribeOptions:
    bpm: float | None = None  # None = tự ước lượng
    tonic: int | None = None  # None = tự dò giọng
    mode: str | None = None
    snap: bool = True  # làm tròn nốt vào thang âm
    fit_range: bool = True  # dịch quãng tám về khoảng giai điệu
    grid_steps: int = 1  # 1 = móc kép, 2 = móc đơn


def transcribe_array(
    y: np.ndarray,
    sr: int,
    opts: TranscribeOptions | None = None,
    params: SegmentParams | None = None,
    progress: Callable[[float], None] | None = None,
    owned: bool = False,
) -> dict:
    """`progress(0..1)` được gọi trong lúc dò cao độ (phần tốn thời gian nhất). `owned`: được sửa thẳng vào `y` cho đỡ RAM."""
    o = opts or TranscribeOptions()
    truncated = len(y) > int(MAX_SECONDS * sr)
    y = y[: int(MAX_SECONDS * sr)]
    peak = float(np.max(np.abs(y))) if len(y) else 0.0
    if peak > 0:
        # chuẩn hoá âm lượng để ngưỡng năng lượng ổn định
        if owned and y.dtype == np.float32 and y.flags.writeable:
            np.divide(y, peak, out=y)
            y *= 0.9
        else:
            y = y / peak * 0.9
    raw: list[NoteEvent] = []
    tuning_cents = 0.0
    if peak > 0.01:
        track = track_pitch(y, sr, progress=(lambda f: progress(0.9 * f)) if progress else None)
        # Bù lệch chuẩn của người ngân trước khi dò giọng và làm tròn nốt.
        # Có model dò onset (backend/models/humming_onset.json) thì tách/gộp nốt theo model, không có thì giữ nguyên.
        raw, tuning_cents = retune(apply_onset_model(segment_notes(track, params), track, y), track)

    weights = [n.offset - n.onset for n in raw]
    if o.tonic is not None and o.mode:
        tonic, mode, conf = o.tonic, o.mode, 1.0
    else:
        tonic, mode, conf = detect_key([n.pitch for n in raw], weights)

    bpm = float(o.bpm) if o.bpm else estimate_bpm(raw)
    steps = quantize(raw, bpm, o.grid_steps)
    shift = octave_shift([s["pitch"] for s in steps]) if o.fit_range else 0
    max_e = max((s["energy"] for s in steps), default=1.0) or 1.0
    melody = []
    for s in steps:
        pitch = s["pitch"] + shift
        if o.snap:
            pitch = snap_to_scale(pitch, tonic, mode)
        melody.append(
            {"pitch": int(pitch), "start": int(s["start"]), "dur": int(s["dur"]), "vel": int(70 + 40 * s["energy"] / max_e)}
        )
    end = max((m["start"] + m["dur"] for m in melody), default=0)
    bars = max(1, int(np.ceil(end / STEPS_PER_BAR)))
    return {
        "bpm": round(bpm, 1),
        "tonic": int(tonic),
        "mode": mode,
        "key_confidence": round(float(conf), 3),
        "bars": bars,
        "octave_shift": shift,
        "tuning_cents": tuning_cents,
        "duration_sec": round(len(y) / sr, 2),
        "truncated": truncated,
        "melody": melody,
        "raw_notes": [{"onset": round(n.onset, 3), "offset": round(n.offset, 3), "pitch": round(n.pitch, 2)} for n in raw],
        "params": asdict(params or SegmentParams()),
    }


def transcribe_bytes(data: bytes, opts: TranscribeOptions | None = None, params: SegmentParams | None = None) -> dict:
    return transcribe_array(load_audio(data, TARGET_SR), TARGET_SR, opts, params, owned=True)


def transcribe_file(path: str, opts: TranscribeOptions | None = None, progress: Callable[[float], None] | None = None) -> dict:
    return transcribe_array(load_audio_file(path, TARGET_SR), TARGET_SR, opts, progress=progress, owned=True)


__all__ = ["NoteEvent", "SegmentParams", "TranscribeOptions", "transcribe_array", "transcribe_bytes", "transcribe_file"]
