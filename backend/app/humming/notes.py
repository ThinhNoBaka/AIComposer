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
    pitch_jump: float = 0.55  # nửa cung: rời mốc của nốt hơn mức này đủ lâu thì tách nốt mới
    jump_frames: int = 5  # số khung liên tiếp phải lệch mới tính là nốt mới
    ref_frames: int = 8  # số khung đầu nốt dùng làm mốc cao độ
    glide_sec: float = 0.18  # mẩu nốt ngắn hơn mức này nằm giữa hai nốt liền nhau thì là đoạn luyến, gộp lại
    vibrato_frames: int = 17  # cửa sổ trung bình trượt (~1 chu kỳ rung giọng) trước khi so mốc
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


def _fill_nan(x: np.ndarray) -> np.ndarray:
    """Nội suy chỗ NaN (vài khung pYIN mất cao độ giữa nốt) để làm mượt được."""
    ok = np.isfinite(x)
    if ok.all() or not ok.any():
        return x
    i = np.arange(len(x))
    return np.interp(i, i[ok], x[ok])


def _moving_average(x: np.ndarray, size: int) -> np.ndarray:
    """Trung bình trượt căn giữa, co cửa sổ ở hai đầu. Cửa sổ ~1 chu kỳ rung (vibrato 5–6 Hz) thì triệt được rung."""
    if size <= 1 or len(x) < 3:
        return x
    k = min(size, len(x) if len(x) % 2 else len(x) - 1)
    c = np.concatenate([[0.0], np.cumsum(x)])
    h = k // 2
    i = np.arange(len(x))
    lo, hi = np.maximum(0, i - h), np.minimum(len(x), i + h + 1)
    return (c[hi] - c[lo]) / (hi - lo)


def _split_on_pitch(region: list[int], contour: np.ndarray, p: SegmentParams) -> list[list[int]]:
    """Tách một đoạn có giọng liền mạch thành các nốt khi cao độ (đã làm mượt) rời mốc của nốt hiện tại đủ lâu.

    Mốc là cao độ phần đầu ổn định của nốt và KHÔNG trượt theo khung mới, nên bước nửa cung luyến liền
    (Mi→Fa, Si→Đô) vẫn tách được, còn rung giọng thì không bị tách nhầm.
    """
    s = contour[region]
    out: list[list[int]] = []
    start = 0
    ref: float | None = None
    run = 0
    for i in range(len(s)):
        if ref is None:
            # Mốc = trung vị của ~80 ms đầu nốt (sau khi đã làm mượt nên trượt vào nốt ảnh hưởng ít).
            if i - start + 1 >= p.ref_frames or i == len(s) - 1:
                ref = float(np.median(s[start : i + 1]))
            continue
        if abs(s[i] - ref) > p.pitch_jump:
            run += 1
            if run >= p.jump_frames:
                cut = i - run + 1
                # Chỗ cắt: khung đầu tiên đi quá nửa đường sang cao độ mới.
                new = float(np.median(s[cut : i + 1]))
                mid = (ref + new) / 2
                j = cut
                while j > start + 1 and (s[j - 1] - mid) * (new - ref) > 0:
                    j -= 1
                out.append(region[start:j])
                start, ref, run = j, None, 0
        else:
            run = 0
    out.append(region[start:])
    segs = [seg for seg in out if seg]
    # Tách nhầm (mốc lấy lúc còn đang trượt vào nốt): hai mẩu liền nhau mà phần giữa cùng cao độ thì nối lại.
    merged: list[list[int]] = []
    for seg in segs:
        if merged and abs(_core_median(contour, merged[-1]) - _core_median(contour, seg)) < p.pitch_jump:
            merged[-1] = merged[-1] + seg
        else:
            merged.append(seg)
    return merged


def _core_median(contour: np.ndarray, seg: list[int]) -> float:
    """Cao độ phần giữa của mẩu (bỏ 25% mỗi đầu là chỗ trượt/luyến)."""
    a, b = len(seg) // 4, max(len(seg) - len(seg) // 4, len(seg) // 4 + 1)
    return float(np.median(contour[seg[a:b]]))


def _merge_glides(notes: list[NoteEvent], track: PitchTrack, p: SegmentParams) -> list[NoteEvent]:
    """Gộp mẩu nốt ngắn sinh ra lúc luyến (cao độ nằm giữa hai nốt kề, nối liền không nghỉ) vào nốt gần cao độ hơn."""
    hop_sec = track.hop / track.sr
    out = list(notes)
    i = 0
    while i < len(out):
        n = out[i]
        prev = out[i - 1] if i > 0 and n.onset - out[i - 1].offset <= 2 * hop_sec else None
        nxt = out[i + 1] if i + 1 < len(out) and out[i + 1].onset - n.offset <= 2 * hop_sec else None
        short = n.offset - n.onset < p.glide_sec
        between = prev is not None and nxt is not None and min(prev.pitch, nxt.pitch) - 0.3 <= n.pitch <= max(prev.pitch, nxt.pitch) + 0.3
        close = [m for m in (prev, nxt) if m is not None and abs(m.pitch - n.pitch) < 1.5]
        if short and (between or close):
            target = min((m for m in (prev, nxt) if m is not None), key=lambda m: abs(m.pitch - n.pitch))
            frames = sorted(target.frames + n.frames)
            merged = NoteEvent(
                onset=min(target.onset, n.onset),
                offset=max(target.offset, n.offset),
                pitch=float(np.nanmedian(track.midi[target.frames])),
                energy=target.energy,
                frames=frames,
            )
            j = out.index(target)
            out[j] = merged
            del out[i]
            i = max(0, i - 1)
            continue
        i += 1
    return out


def segment_notes(track: PitchTrack, params: SegmentParams | None = None) -> list[NoteEvent]:
    p = params or SegmentParams()
    midi = track.midi.copy()
    voiced = (track.voiced_prob >= p.voiced_threshold) & np.isfinite(midi) & (track.rms >= p.min_rms)

    # 1. Các đoạn có giọng liền mạch (lặng ngắn hơn gap_frames thì vẫn tính là liền).
    regions: list[list[int]] = []
    cur: list[int] = []
    gap = 0
    for i in range(len(midi)):
        if voiced[i]:
            if cur and gap >= p.gap_frames:
                regions.append(cur)
                cur = []
            cur.append(i)
            gap = 0
        else:
            gap += 1
    if cur:
        regions.append(cur)

    # 2. Trong mỗi đoạn: làm mượt cao độ rồi tách theo bước nhảy cao độ, sau đó tách theo chỗ tụt âm lượng.
    hop_sec = track.hop / track.sr
    notes: list[NoteEvent] = []
    for region in regions:
        lo, hi = region[0], region[-1] + 1
        raw = np.where(voiced[lo:hi], midi[lo:hi], np.nan)
        filled = _fill_nan(raw)
        if p.smooth_frames > 1:
            filled = median_filter(filled, size=min(p.smooth_frames, len(filled)), mode="nearest")
        contour = np.full(len(midi), np.nan)
        contour[lo:hi] = _moving_average(filled, p.vibrato_frames)
        full = list(range(lo, hi))
        for seg in _split_on_pitch(full, contour, p):
            seg = [i for i in seg if voiced[i]]
            for part in _split_on_energy_dips(seg, track.rms, p):
                onset = float(track.times[part[0]])
                offset = float(track.times[part[-1]] + hop_sec)
                if offset - onset < p.min_note_sec:
                    continue
                notes.append(
                    NoteEvent(
                        onset=onset,
                        offset=offset,
                        pitch=float(np.nanmedian(midi[part])),
                        energy=float(np.mean(track.rms[part])),
                        frames=part,
                    )
                )
    return _merge_glides(notes, track, p)
