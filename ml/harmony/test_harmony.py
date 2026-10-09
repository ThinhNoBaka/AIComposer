"""Kiểm thử đầu-cuối trên dữ liệu giả: vài bài MIDI nhỏ tạo bằng pretty_midi theo đúng định dạng POP909.

    python -m pytest ml/harmony/test_harmony.py
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pretty_midi
import pytest

import build_dataset as B
import train as T

BEAT = 0.5  # 120 BPM
BAR = 4 * BEAT
NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]


def make_song(folder: Path, tonic: int, mode: str, degrees: list[int], seventh_at: int | None = None) -> None:
    """Một bài: mỗi ô một hợp âm (theo bậc), giai điệu là các nốt của hợp âm đó."""
    folder.mkdir(parents=True)
    sid = folder.name
    scale = B.SCALES[mode]
    pm = pretty_midi.PrettyMIDI(initial_tempo=120)
    mel = pretty_midi.Instrument(program=0, name="MELODY")
    piano = pretty_midi.Instrument(program=0, name="PIANO")
    chord_lines = []
    for b, d in enumerate(degrees):
        start = b * BAR
        tones = [60 + tonic + scale[(d + k) % 7] + (12 if d + k >= 7 else 0) for k in (0, 2, 4, 2)]
        for i, p in enumerate(tones):
            mel.notes.append(pretty_midi.Note(velocity=90, pitch=p, start=start + i * BEAT, end=start + (i + 1) * BEAT))
        piano.notes.append(pretty_midi.Note(velocity=60, pitch=48 + tonic + scale[d], start=start, end=start + BAR))
        root = NAMES[(tonic + scale[d]) % 12]
        third = (scale[(d + 2) % 7] - scale[d]) % 12
        quality = "maj" if third == 4 else "min"
        if b == seventh_at:
            quality += "7"
        chord_lines.append(f"{start}\t{start + BAR}\t{root}:{quality}")
    # Một hợp âm ngoài thang âm ở ô cuối (nốt gốc lệch nửa cung so với nốt chủ) và đoạn N ở đầu.
    end = len(degrees) * BAR
    chord_lines.append(f"{end}\t{end + BAR}\t{NAMES[(tonic + 1) % 12]}:maj")
    mel.notes.append(pretty_midi.Note(velocity=90, pitch=61 + tonic, start=end, end=end + BAR))
    pm.instruments += [mel, piano]
    pm.write(str(folder / f"{sid}.mid"))
    (folder / "chord_midi.txt").write_text("0\t0.001\tN\n" + "\n".join(chord_lines) + "\n")
    q = "maj" if mode == "major" else "min"
    (folder / "key_audio.txt").write_text(f"0.0\t{end + BAR}\t{NAMES[tonic]}:{q}\n")
    beats = [f"{i * BEAT} {1.0 if i % 2 == 0 else 0.0} {1.0 if i % 4 == 0 else 0.0}" for i in range(4 * (len(degrees) + 1))]
    (folder / "beat_midi.txt").write_text("\n".join(beats))


@pytest.fixture()
def dataset(tmp_path: Path) -> Path:
    raw = tmp_path / "raw"
    progs = [[0, 3, 4, 0], [0, 5, 3, 4, 0], [0, 4, 5, 3, 0], [5, 3, 0, 4, 0]]
    for i in range(12):
        tonic = (i * 5) % 12
        mode = "major" if i % 2 == 0 else "minor"
        make_song(raw / f"{i + 1:03d}", tonic, mode, progs[i % 4], seventh_at=2 if i % 3 == 0 else None)
    out = tmp_path / "bars.npz"
    B.build(raw, out, verbose=False)
    return out


def test_parse_chord_label() -> None:
    assert B.parse_chord_label("F#:maj7/5") == (6, True)
    assert B.parse_chord_label("Bb:min") == (10, False)
    assert B.parse_chord_label("Db:sus4(b7)") == (1, True)
    assert B.parse_chord_label("N") == (None, False)
    assert B.name_to_pc("Cb") == 11


def test_build_dataset(dataset: Path) -> None:
    d = T.load(dataset)
    assert len(d["song_ids"]) == 12
    first = slice(int(d["offsets"][0]), int(d["offsets"][1]))
    # Bài 001: Đô trưởng, I IV V I rồi một ô hợp âm ngoài thang (C#) → -1.
    assert d["degree"][first].tolist() == [0, 3, 4, 0, -1]
    assert d["mode"][first].tolist() == [0] * 5
    assert d["seventh"][first].tolist() == [0, 0, 1, 0, 0]
    # Histogram theo giọng, đơn vị phách: ô I = C, E, G, E.
    assert d["hist"][first][0].tolist() == pytest.approx([1, 0, 0, 0, 2, 0, 0, 1, 0, 0, 0, 0])
    assert d["strong"][first][0].sum() == pytest.approx(2)  # nốt ở phách 1 và 3
    # Bài 002 ở giọng thứ, nốt chủ F: bậc vẫn được quy đúng.
    second = slice(int(d["offsets"][1]), int(d["offsets"][2]))
    assert d["mode"][second][0] == 1
    assert d["degree"][second].tolist()[:5] == [0, 5, 3, 4, 0]


def test_train_end_to_end(dataset: Path, tmp_path: Path) -> None:
    d = T.load(dataset)
    model = T.fit(d, np.arange(len(d["song_ids"])))
    for mm in model.values():
        assert mm["start"].sum() == pytest.approx(1)
        assert mm["prior"].sum() == pytest.approx(1)
        assert mm["trans"].sum(1) == pytest.approx(np.ones(7))
        assert mm["emit"].sum(1) == pytest.approx(np.ones(7))
        assert (mm["emit"] > 0).all()  # làm trơn Laplace

    # Giai điệu toàn nốt hợp âm: Viterbi khôi phục đúng các bậc.
    res = T.evaluate(d, np.arange(len(d["song_ids"])), model, 1.0)
    assert T.accuracy(res["hmm"]) > 0.9
    assert T.accuracy(res["rules"]) > 0.9

    out = tmp_path / "harmonyModel.json"
    T.export(model, 1.0, 12, out)
    doc = json.loads(out.read_text())
    assert doc["source"] == "POP909" and doc["version"] == 1
    for mode in ("major", "minor"):
        m = doc["modes"][mode]
        assert sum(m["start"]) == pytest.approx(1, abs=1e-3)
        for row in m["trans"] + m["emit"]:
            assert sum(row) == pytest.approx(1, abs=1e-3)
            assert min(row) > 0
        assert len(m["emit"][0]) == 12 and len(m["seventhRate"]) == 7


def test_split_is_by_song() -> None:
    train, test = T.split_songs(100, 0.1, seed=1)
    assert len(test) == 10 and len(train) == 90
    assert not set(train) & set(test)
