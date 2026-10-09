"""Đổi cao độ giọng hát bằng TD-PSOLA (Time-Domain Pitch-Synchronous Overlap-Add), chỉ dùng numpy/scipy.

Ý tưởng:
- Trong mỗi đoạn có giọng, đặt các "mốc chu kỳ" (pitch mark) cách nhau đúng một chu kỳ F0, tinh chỉnh vào đỉnh
  của tín hiệu đã lọc thông thấp quanh tần số cơ bản để các mốc khớp pha với nhau.
- Mỗi mốc cắt ra một hạt (grain) dài 2 chu kỳ, nhân cửa sổ Hann.
- Đặt lại các hạt theo khoảng cách chu kỳ mới (chu kỳ thật / tỉ lệ đổi cao độ) rồi cộng chồng. Hạt nào được dùng là
  hạt có mốc gần nhất về thời gian, nên độ dài bản thu giữ nguyên và hình bao phổ (formant) gần như giữ nguyên.
- Đoạn không có giọng (phụ âm, hơi thở, lặng) chép nguyên bản gốc, nối với đoạn đã xử lý bằng crossfade ngắn.
"""

from __future__ import annotations

from functools import lru_cache

import numpy as np
from scipy.signal import butter, sosfiltfilt

MIN_SHIFT_CENTS = 0.5  # đoạn nào lệch ít hơn mức này thì giữ nguyên bản gốc


def voiced_runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """Các đoạn liên tiếp True dạng [(đầu, cuối_không_tính)]."""
    m = np.concatenate([[False], np.asarray(mask, dtype=bool), [False]])
    d = np.diff(m.astype(np.int8))
    starts = np.flatnonzero(d == 1)
    ends = np.flatnonzero(d == -1)
    return list(zip(starts.tolist(), ends.tolist()))


@lru_cache(maxsize=4096)
def _hann(half: int) -> np.ndarray:
    # Hann đối xứng dài 2*half+1: hai cửa sổ cách nhau `half` mẫu cộng lại đúng bằng 1.
    return np.hanning(2 * half + 1)


def _pitch_marks(lp: np.ndarray, period: np.ndarray) -> np.ndarray:
    """Mốc chu kỳ (số thực, đơn vị mẫu) trong một đoạn có giọng.

    `lp` là tín hiệu đoạn đó đã lọc giữ lại hoà âm cơ bản, `period` là chu kỳ ước lượng tại từng mẫu.
    Mỗi mốc mới = mốc trước + một chu kỳ, rồi dời về đỉnh gần nhất (±20% chu kỳ), nội suy parabol để lấy phần lẻ.
    """
    n = len(lp)
    first = max(1, int(period[0]))
    m = float(np.argmax(lp[: min(first + 1, n)]))
    marks = [m]
    while True:
        T = period[min(int(m), n - 1)]
        pred = m + T
        if pred >= n - 1:
            break
        r = max(1, int(0.2 * T))
        lo = max(1, int(pred) - r)
        hi = min(n - 1, int(pred) + r + 1)
        if hi <= lo:
            break
        k = lo + int(np.argmax(lp[lo:hi]))
        a, b, c = lp[k - 1], lp[k], lp[k + 1]
        den = a - 2 * b + c
        frac = 0.5 * (a - c) / den if den < 0 else 0.0
        new = k + float(np.clip(frac, -0.5, 0.5))
        # Đỉnh tìm được lệch quá xa dự đoán (nhiễu, đổi hình dạng sóng) thì tin vào F0 ước lượng.
        if abs(new - pred) > 0.2 * T or new <= m:
            new = pred
        marks.append(new)
        m = new
    return np.asarray(marks)


def psola_shift(
    y: np.ndarray,
    sr: int,
    f0: np.ndarray,
    voiced: np.ndarray,
    target_f0: np.ndarray,
    hop_s: float,
    fade_ms: float = 10.0,
) -> np.ndarray:
    """Đổi cao độ `y` từ đường F0 `f0` (Hz, theo khung cách nhau `hop_s` giây, khung i ở thời điểm i*hop_s)
    sang `target_f0`. Khung không có giọng (voiced=False hoặc F0 không hợp lệ) giữ nguyên.

    Thực tế dùng tỉ lệ target/f0 áp lên chu kỳ đo được từ các mốc, nên rung nhỏ tự nhiên của giọng vẫn còn.
    Trả về mảng float32 cùng độ dài với `y`.
    """
    y = np.asarray(y, dtype=np.float64)
    n = len(y)
    f0 = np.asarray(f0, dtype=np.float64)
    target_f0 = np.asarray(target_f0, dtype=np.float64)
    nf = min(len(f0), len(target_f0), len(voiced))
    f0, target_f0 = f0[:nf], target_f0[:nf]
    with np.errstate(invalid="ignore"):
        ok = np.asarray(voiced[:nf], dtype=bool) & np.isfinite(f0) & np.isfinite(target_f0) & (f0 > 0) & (target_f0 > 0)

    acc = np.zeros(n)
    wsum = np.zeros(n)
    mask = np.zeros(n)
    fade = max(1, int(fade_ms * sr / 1000))
    frame_t = np.arange(nf) * hop_s

    for a, b in voiced_runs(ok):
        ratio_frames = target_f0[a:b] / f0[a:b]
        if np.max(np.abs(1200 * np.log2(ratio_frames))) < MIN_SHIFT_CENTS:
            continue
        s0 = max(0, int(round((frame_t[a] - hop_s / 2) * sr)))
        s1 = min(n, int(round((frame_t[b - 1] + hop_s / 2) * sr)))
        tt = np.arange(s0, s1) / sr
        if len(tt) == 0:
            continue
        fa = np.interp(tt, frame_t[a:b], f0[a:b])
        period = sr / fa
        if s1 - s0 < 3 * period.max():
            continue  # ngắn hơn 3 chu kỳ: không đủ để làm PSOLA
        ratio = np.interp(tt, frame_t[a:b], ratio_frames)

        seg = y[s0:s1]
        cutoff = min(1.5 * float(np.median(fa)), 0.45 * sr)
        try:
            lp = sosfiltfilt(butter(2, cutoff, fs=sr, output="sos"), seg)
        except ValueError:  # đoạn quá ngắn cho bộ lọc
            lp = seg
        marks = _pitch_marks(lp, period)
        if len(marks) < 3:
            continue

        # Chu kỳ thật tại từng mốc = khoảng cách tới các mốc kề bên, làm mượt nhẹ để bớt rung do làm tròn.
        sp = np.diff(marks)
        pa = np.empty(len(marks))
        pa[0], pa[-1] = sp[0], sp[-1]
        pa[1:-1] = 0.5 * (sp[:-1] + sp[1:])
        est = period[np.minimum(marks.astype(int), len(period) - 1)]
        pa = np.where(np.abs(pa / est - 1) > 0.15, est, pa)  # mốc hỏng thì dùng chu kỳ ước lượng

        # Mốc tổng hợp: bắt đầu ở mốc phân tích đầu tiên, bước theo chu kỳ mới.
        syn = []
        t = marks[0]
        L = s1 - s0
        while t < L:
            syn.append(t)
            i = min(int(t), L - 1)
            pa_here = np.interp(t, marks, pa)
            t += max(pa_here / ratio[i], 2.0)
        syn_arr = np.asarray(syn)
        idx = np.clip(np.searchsorted(marks, syn_arr), 1, len(marks) - 1)
        nearest = np.where(np.abs(marks[idx - 1] - syn_arr) <= np.abs(marks[idx] - syn_arr), idx - 1, idx)

        for ts, k in zip(syn_arr.tolist(), nearest.tolist()):
            half = max(2, int(round(pa[k])))
            src_c = s0 + int(round(marks[k]))
            dst_c = s0 + int(round(ts))
            # cắt cho vừa biên của cả nguồn lẫn đích
            lo = max(-half, -src_c, -dst_c)
            hi = min(half, n - 1 - src_c, n - 1 - dst_c)
            if hi <= lo:
                continue
            w = _hann(half)[lo + half : hi + half + 1]
            acc[dst_c + lo : dst_c + hi + 1] += y[src_c + lo : src_c + hi + 1] * w
            wsum[dst_c + lo : dst_c + hi + 1] += w

        # Trọng số trộn: 1 trong đoạn, thoải dần `fade` mẫu ở hai đầu.
        ramp = np.ones(s1 - s0)
        f = min(fade, (s1 - s0) // 2)
        if f > 0:
            r = np.linspace(0.0, 1.0, f, endpoint=False)
            ramp[:f] = r
            ramp[-f:] = r[::-1]
        np.maximum(mask[s0:s1], ramp, out=mask[s0:s1])

    if not mask.any():
        return y.astype(np.float32)
    shifted = acc / np.maximum(wsum, 0.2)
    weight = mask * np.clip((wsum - 0.15) / 0.35, 0.0, 1.0)  # chỗ hạt phủ không đủ thì dùng bản gốc
    out = y + weight * (shifted - y)
    return out.astype(np.float32)
