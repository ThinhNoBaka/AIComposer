"""Bù lệch cao độ của người ngân trước khi làm tròn nốt.

Người không học nhạc hiếm khi ngân đúng chuẩn La = 440 Hz: cả bài thường lệch chung vài chục cent và trôi dần
(hay xuống thấp) khi ngân lâu. Nếu cứ làm tròn từng nốt về nửa cung gần nhất, một người lệch ~50 cent sẽ có
nốt nhảy lung tung giữa hai nửa cung kề nhau. Ở đây ta:
1. lấy cao độ ở phần ổn định của nốt (bỏ đoạn trượt vào nốt và đoạn luyến sang nốt sau);
2. ước lượng "chuẩn riêng" của người ngân theo thời gian (trung bình vòng của phần lẻ cent, theo cửa sổ trượt);
3. trừ chuẩn riêng đó đi rồi mới làm tròn.
"""

from __future__ import annotations

import numpy as np

from .notes import NoteEvent
from .pitch import PitchTrack

WINDOW_SEC = 3.0  # độ rộng cửa sổ (sigma) theo dõi cao độ trôi
GLOBAL_WEIGHT = 0.2  # kéo nhẹ về độ lệch chung của cả bản ngân, để vài nốt hát sai không làm lệch chuẩn


def stable_pitch(note: NoteEvent, track: PitchTrack) -> float:
    """Cao độ của phần ổn định trong nốt: bỏ khung đổi cao độ nhanh (trượt, luyến), lấy trung vị phần còn lại."""
    idx = np.asarray(note.frames)
    if len(idx) < 5:
        return note.pitch
    m = track.midi[idx]
    ok = np.isfinite(m)
    if ok.sum() < 3:
        return note.pitch
    m = np.where(ok, m, np.nanmedian(m))
    # Bỏ 15% đầu (trượt vào nốt) và 10% cuối (luyến sang nốt sau).
    a, b = int(len(m) * 0.15), max(int(len(m) * 0.9), int(len(m) * 0.15) + 3)
    core = m[a:b]
    slope = np.abs(np.gradient(core)) if len(core) > 2 else np.zeros(len(core))
    steady = core[slope < 0.08]  # dưới ~8 cent mỗi 10 ms
    return float(np.median(steady if len(steady) >= 3 else core))


def _circ_offset(frac: np.ndarray, w: np.ndarray) -> float:
    """Trung bình vòng của phần lẻ (đơn vị nửa cung, trong [-0.5, 0.5))."""
    z = np.sum(w * np.exp(2j * np.pi * frac))
    return float(np.angle(z) / (2 * np.pi)) if abs(z) > 1e-9 else 0.0


def tuning_offsets(onsets: np.ndarray, pitches: np.ndarray, weights: np.ndarray) -> np.ndarray:
    """Độ lệch chuẩn riêng (nửa cung) tại từng nốt."""
    if len(pitches) == 0:
        return np.zeros(0)
    frac = pitches - np.round(pitches)
    glob = _circ_offset(frac, weights)
    ang = np.empty(len(pitches))
    for i, t in enumerate(onsets):
        w = weights * np.exp(-0.5 * ((onsets - t) / WINDOW_SEC) ** 2)
        local = np.sum(w * np.exp(2j * np.pi * frac))
        z = local + GLOBAL_WEIGHT * np.sum(w) * np.exp(2j * np.pi * glob)
        ang[i] = np.angle(z)
    # Mở vòng (unwrap): người ngân trôi từ -40 cent xuống -60 cent là trôi liên tục, không phải nhảy sang +40 cent
    # của nửa cung bên dưới. Không mở vòng thì mọi nốt sau chỗ đó bị lệch hẳn một nửa cung so với phần trước.
    order = np.argsort(onsets, kind="stable")
    out = np.empty(len(pitches))
    out[order] = np.unwrap(ang[order]) / (2 * np.pi)
    return out


def retune(notes: list[NoteEvent], track: PitchTrack) -> tuple[list[NoteEvent], float]:
    """Trả về nốt đã bù lệch (pitch gần số nguyên hơn) và độ lệch chung (cent) để hiển thị/ghi log."""
    if not notes:
        return notes, 0.0
    pitches = np.array([stable_pitch(n, track) for n in notes])
    onsets = np.array([n.onset for n in notes])
    weights = np.array([max(0.05, n.offset - n.onset) for n in notes])
    off = tuning_offsets(onsets, pitches, weights)
    out = [
        NoteEvent(onset=n.onset, offset=n.offset, pitch=float(p - o), energy=n.energy, frames=n.frames)
        for n, p, o in zip(notes, pitches, off)
    ]
    glob = _circ_offset(pitches - np.round(pitches), weights)
    return out, round(glob * 100, 1)
