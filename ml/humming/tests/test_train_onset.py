"""Chạy thử train_onset.py từ đầu đến cuối trên dữ liệu giả lập (giả cả thư mục kiểu HumTrans: wav + mid)."""

import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

import train_onset  # noqa: E402
from app.humming import onset_model as om  # noqa: E402  (train_onset đã thêm backend vào sys.path)


def write_humtrans_like(folder: Path, n: int) -> None:
    import pretty_midi
    import soundfile as sf

    (folder / "wav").mkdir(parents=True)
    (folder / "midi").mkdir()
    for name, y, ref in train_onset.synthetic_items(n, seed=7):
        sf.write(folder / "wav" / f"{name}.wav", y, train_onset.TARGET_SR)
        pm = pretty_midi.PrettyMIDI()
        inst = pretty_midi.Instrument(0)
        inst.notes = [pretty_midi.Note(velocity=90, pitch=int(p), start=a, end=b) for a, b, p in ref]
        pm.instruments.append(inst)
        pm.write(str(folder / "midi" / f"{name}.mid"))


def check_model(path: Path) -> dict:
    d = json.loads(path.read_text(encoding="utf-8"))
    for key in ("version", "feature_names", "mean", "std", "layers", "threshold", "hop_length", "sr"):
        assert key in d
    model = om.OnsetModel.from_dict(d)  # backend đọc được
    assert len(model.mean) == len(d["feature_names"])
    assert 0 < d["threshold"] < 1
    return d


def test_synthetic_end_to_end(tmp_path):
    out = tmp_path / "humming_onset.json"
    assert train_onset.main(["--synthetic", "6", "--epochs", "3", "--out", str(out)]) == 0
    d = check_model(out)
    assert d["trained_on"]["source"] == "synthetic"
    assert "note_f1_model" in d["metrics"]


def test_humtrans_folder_with_cache(tmp_path):
    pytest.importorskip("pretty_midi")
    data = tmp_path / "HumTrans"
    write_humtrans_like(data, 4)
    out = tmp_path / "m.json"
    args = ["--data", str(data), "--epochs", "2", "--hidden", "--cache-dir", str(tmp_path / "cache"), "--out", str(out)]
    assert train_onset.main(args) == 0
    assert len(list((tmp_path / "cache").glob("*.npz"))) == 4
    d = check_model(out)
    assert len(d["layers"]) == 1  # --hidden không giá trị = hồi quy logistic
    # Lần hai đọc từ cache.
    assert train_onset.main(args) == 0


def test_align_reference_recovers_late_start():
    """Nhãn bắt đầu ở 0 nhưng tiếng ngân vào trễ 0,23 s (như HumTrans): căn giờ phải tìm lại độ dời đó."""
    import numpy as np

    from app.humming.pitch import PitchTrack

    ref = [(0.0, 0.4, 60.0), (0.45, 0.9, 64.0), (0.95, 1.5, 67.0), (1.55, 2.0, 65.0), (2.05, 2.6, 62.0)]
    times = np.arange(0, 3.5, 0.01)
    midi = np.full_like(times, np.nan)
    for a, b, p in ref:
        midi[(times >= a + 0.23) & (times < b + 0.23)] = p + 12.2  # ngân cao hơn một quãng tám, lệch chuẩn nhẹ
    track = PitchTrack(times=times, midi=midi, voiced_prob=np.ones_like(times), rms=np.ones_like(times), sr=16000, hop=160)
    aligned, rate = train_onset.align_reference(ref, track)
    assert rate > 0.9
    assert abs(aligned[0][0] - 0.23) <= 0.015
    assert abs(aligned[-1][0] - (2.05 + 0.23)) <= 0.03
