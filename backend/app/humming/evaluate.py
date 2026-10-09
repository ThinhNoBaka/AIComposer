"""Đánh giá nhận nốt theo chuẩn MIR: note precision / recall / F1 (mir_eval)."""

from __future__ import annotations

import numpy as np
import mir_eval

from .notes import NoteEvent


def _arrays(notes: list[tuple[float, float, float]]) -> tuple[np.ndarray, np.ndarray]:
    if not notes:
        return np.zeros((0, 2)), np.zeros(0)
    iv = np.array([[on, off] for on, off, _ in notes], dtype=float)
    hz = np.array([440.0 * 2 ** ((p - 69) / 12) for _, _, p in notes], dtype=float)
    return iv, hz


def note_scores(
    ref: list[tuple[float, float, float]],
    est: list[tuple[float, float, float]] | list[NoteEvent],
    onset_tolerance: float = 0.05,
    pitch_tolerance: float = 50.0,
) -> dict[str, float]:
    """F1 chỉ xét onset + cao độ (chuẩn hay dùng cho humming) và F1 xét cả offset."""
    est_t = [(n.onset, n.offset, n.pitch) if isinstance(n, NoteEvent) else n for n in est]
    ref_iv, ref_hz = _arrays(ref)
    est_iv, est_hz = _arrays(est_t)
    if len(ref_iv) == 0 or len(est_iv) == 0:
        return {"precision": 0.0, "recall": 0.0, "f1": 0.0, "f1_with_offset": 0.0, "n_ref": len(ref_iv), "n_est": len(est_iv)}
    p, r, f, _ = mir_eval.transcription.precision_recall_f1_overlap(
        ref_iv, ref_hz, est_iv, est_hz, onset_tolerance=onset_tolerance, pitch_tolerance=pitch_tolerance, offset_ratio=None
    )
    _, _, f_off, _ = mir_eval.transcription.precision_recall_f1_overlap(
        ref_iv, ref_hz, est_iv, est_hz, onset_tolerance=onset_tolerance, pitch_tolerance=pitch_tolerance
    )
    return {"precision": p, "recall": r, "f1": f, "f1_with_offset": f_off, "n_ref": len(ref_iv), "n_est": len(est_iv)}
