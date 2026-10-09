"""Tách chuỗi cao độ liên tục thành các nốt rời rạc."""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.ndimage import median_filter

from .pitch import PitchTrack


@dataclass
class SegmentParams:
    voiced_threshold: float = 0.25  # xác suất có giọng tối thiểu
    min_note_sec: float = 0.08  # nốt ngắn hơn bị bỏ
    pitch_jump: float = 0.75  # nửa cung: lệch hơn mức này đủ lâu thì tách nốt mới
    jump_frames: int = 4  # số khung liên tiếp phải lệch mới tính là nốt mới
    gap_frames: int = 4  # số khung im lặng để kết thúc nốt
    smooth_frames: int = 5  # cửa sổ lọc trung vị
    energy_dip: float = 0.45  # tỉ lệ năng lượng tụt so với đỉnh trước để tách nốt cùng cao độ
    min_rms: float = 0.005  # dưới mức này coi là im lặng


@dataclass
class NoteEvent:
    onset: float
    offset: float
    pitch: float  # MIDI số thực (trung vị trong nốt)
    energy: float = 0.0
    frames: list[int] = field(default_factory=list, repr=False)

    @property
    def midi(self) -> int:
        return int(round(self.pitch))


def _split_on_energy_dips(idx: list[int], rms: np.ndarray, params: SegmentParams) -> list[list[int]]:
    """Một đoạn liền cao độ nhưng có chỗ năng lượng tụt sâu rồi lên lại (vd. "đa-đa") → tách đôi."""
    if len(idx) < 12:
        return [idx]
    e = rms[idx]
    out: list[list[int]] = []
    start = 0
    peak = e[0]
    min_len = 5
    i = 1
    while i < len(idx) - min_len:
        peak = max(peak, e[i])
        if i - start >= min_len and e[i] < params.energy_dip * peak:
            # tìm đáy rồi xem năng lượng có hồi lại không
            j = i
            while j + 1 < len(idx) and e[j + 1] <= e[j]:
                j += 1
            k = j
            while k + 1 < len(idx) and e[k + 1] >= e[k]:
                k += 1
            if e[k] > e[j] / params.energy_dip and len(idx) - j >= min_len:
                out.append(idx[start:j])
                start = j
                peak = e[j]
                i = k
                continue
        i += 1
    out.append(idx[start:])
    return [s for s in out if s]


def segment_notes(track: PitchTrack, params: SegmentParams | None = None) -> list[NoteEvent]:
    p = params or SegmentParams()
    midi = track.midi.copy()
    voiced = (track.voiced_prob >= p.voiced_threshold) & np.isfinite(midi) & (track.rms >= p.min_rms)
    filled = np.where(voiced, midi, np.nan)
    if p.smooth_frames > 1 and voiced.any():
        tmp = np.where(voiced, midi, np.nanmedian(midi[voiced]))
        smooth = median_filter(tmp, size=p.smooth_frames, mode="nearest")
        filled = np.where(voiced, smooth, np.nan)

    segments: list[list[int]] = []
    cur: list[int] = []
    gap = 0
    off_run: list[int] = []
    for i in range(len(filled)):
        if not voiced[i]:
            gap += 1
            if cur and gap >= p.gap_frames:
                segments.append(cur)
                cur, off_run = [], []
            continue
        gap = 0
        if not cur:
            cur = [i]
            continue
        ref = float(np.median(filled[cur[-min(len(cur), 15):]]))
        if abs(filled[i] - ref) > p.pitch_jump:
            off_run.append(i)
            if len(off_run) >= p.jump_frames:
                segments.append(cur)
                cur, off_run = list(off_run), []
        else:
            cur.extend(off_run)
            off_run = []
            cur.append(i)
    if cur:
        segments.append(cur + off_run)

    hop_sec = track.hop / track.sr
    notes: list[NoteEvent] = []
    for seg in segments:
        for part in _split_on_energy_dips(seg, track.rms, p):
            onset = float(track.times[part[0]])
            offset = float(track.times[part[-1]] + hop_sec)
            if offset - onset < p.min_note_sec:
                continue
            notes.append(
                NoteEvent(
                    onset=onset,
                    offset=offset,
                    pitch=float(np.median(filled[part])),
                    energy=float(np.mean(track.rms[part])),
                    frames=part,
                )
            )
    return notes
