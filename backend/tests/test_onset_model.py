"""Mô hình onset học từ dữ liệu (app/humming/onset_model.py): không có file thì không đổi gì, có file thì chẻ/gộp nốt."""

import json

import numpy as np
import pytest

from app.humming import onset_model as om
from app.humming.notes import NoteEvent, segment_notes
from app.humming.pitch import track_pitch
from app.humming.synth import synth_hum
from tests.test_humming import melody_seconds

SR = 16000


def dip_model(bias: float = -6.0, context: int = 3) -> dict:
    """Mô hình viết tay: onset ở chỗ năng lượng tụt rồi lên lại (đạo hàm bậc hai của rms_db quanh khung)."""
    base = list(om.BASE_FEATURES)
    names = om.stacked_names(base, context)
    w = np.zeros((len(names), 1))
    for name, weight in (("rms_db@-3", 2.0), ("rms_db@+0", -4.0), ("rms_db@+3", 2.0)):
        w[names.index(name), 0] = weight
    return {
        "version": 1,
        "base_features": base,
        "context": context,
        "feature_names": names,
        "mean": [0.0] * len(names),
        "std": [1.0] * len(names),
        "layers": [{"W": w.tolist(), "b": [bias], "act": "sigmoid"}],
        "threshold": 0.5,
        "min_gap_frames": 6,
        "hop_length": 160,
        "sr": SR,
    }


@pytest.fixture
def model_file(tmp_path, monkeypatch):
    def write(d: dict):
        path = tmp_path / "humming_onset.json"
        path.write_text(json.dumps(d), encoding="utf-8")
        monkeypatch.setenv("HUMMING_MODEL", str(path))
        return path

    return write


def legato_hum(seed=3):
    """Bốn nốt Sol liền hơi (không có khoảng lặng): chỉ có chỗ hơi nhấn lại ở đầu mỗi nốt."""
    ref = melody_seconds([67, 67, 67, 67], 90, gap=0.0)
    y = synth_hum(ref, SR, seed=seed)
    return ref, y, track_pitch(y, SR)


def test_no_model_file_keeps_notes_unchanged(tmp_path, monkeypatch):
    monkeypatch.setenv("HUMMING_MODEL", str(tmp_path / "khong_co.json"))
    assert om.load_model() is None
    ref = melody_seconds([60, 64, 67], 100)
    y = synth_hum(ref, SR, seed=1)
    track = track_pitch(y, SR)
    notes = segment_notes(track)
    before = [(n.onset, n.offset, n.pitch, n.energy) for n in notes]
    out = om.apply_onset_model(notes, track, y)
    assert out is notes
    assert [(n.onset, n.offset, n.pitch, n.energy) for n in out] == before


def test_default_path_and_disable(monkeypatch, tmp_path):
    monkeypatch.delenv("HUMMING_MODEL", raising=False)
    assert om.model_path() == om.DEFAULT_MODEL_PATH
    assert om.DEFAULT_MODEL_PATH.parts[-2:] == ("models", "humming_onset.json")
    monkeypatch.setattr(om, "DEFAULT_MODEL_PATH", tmp_path / "chua_train.json")
    assert om.load_model() is None
    monkeypatch.setenv("HUMMING_MODEL", "none")
    assert om.model_path() is None and om.load_model() is None


def test_broken_model_file_falls_back(model_file):
    bad = dip_model()
    bad["feature_names"] = bad["feature_names"][:-1]
    model_file(bad)
    assert om.load_model() is None
    notes = [NoteEvent(0.3, 1.0, 60.0)]
    _, y, track = legato_hum()
    assert om.apply_onset_model(notes, track, y) is notes


def test_model_splits_repeated_same_pitch_hum(model_file):
    model_file(dip_model())
    model = om.load_model()
    assert model is not None and len(model.mean) == len(om.BASE_FEATURES) * 7
    ref, y, track = legato_hum()
    whole = [NoteEvent(ref[0][0], ref[-1][1], 67.0)]  # cả câu bị nhận thành một nốt dài
    out = om.apply_onset_model(whole, track, y)
    assert len(out) == 4
    for n, (on, _, p) in zip(out, ref):
        assert abs(n.onset - on) <= 0.05
        assert n.pitch == pytest.approx(p, abs=0.5)
    assert all(a.offset <= b.onset + 1e-9 for a, b in zip(out, out[1:]))


def test_model_without_onsets_merges_breath_dips(model_file):
    model_file(dip_model(bias=-100.0))  # mô hình không bao giờ thấy onset
    ref, y, track = legato_hum()
    # Nốt bị chẻ nhầm ở chỗ hụt hơi (cùng cao độ, sát nhau) được gộp lại; nốt khác cao độ thì giữ.
    notes = [NoteEvent(0.3, 0.8, 67.0), NoteEvent(0.8, 1.4, 67.1), NoteEvent(1.42, 2.0, 69.0)]
    out = om.apply_onset_model(notes, track, y)
    assert len(out) == 2
    assert out[0].onset == pytest.approx(0.3, abs=0.011) and out[0].offset == pytest.approx(1.4, abs=0.011)
    assert out[1].onset == pytest.approx(1.42, abs=1e-9)


def test_feature_matrix_matches_names():
    _, y, track = legato_hum()
    x = om.frame_features(track, y)
    assert x.shape == (len(track.midi), len(om.stacked_names(om.BASE_FEATURES, 3)))
    assert np.isfinite(x).all()
    # Không có audio: các đặc trưng phổ bằng 0, phần còn lại không đổi.
    x0 = om.frame_features(track, None, ["rms_db", "flux"], 0)
    assert np.all(x0[:, 1] == 0) and np.array_equal(x0[:, 0], x[:, om.stacked_names(om.BASE_FEATURES, 3).index("rms_db@+0")])
