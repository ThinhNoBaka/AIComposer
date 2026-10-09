"""Chạy: python -m pytest ml/drums -q"""

import csv
import io
import json
import sys
import zipfile
from pathlib import Path

import pretty_midi

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import train_groove as tg  # noqa: E402


def _beat_midi(bpm: float, bars: int, lead_in_beats: int = 0, snare_vel: int = 100) -> bytes:
    """Rock cơ bản: kick 1 và 3, snare 2 và 4, hi-hat móc đơn; có thể bắt đầu lệch vài phách."""
    pm = pretty_midi.PrettyMIDI(initial_tempo=bpm)
    inst = pretty_midi.Instrument(program=0, is_drum=True)
    step = 60 / bpm / 4
    for b in range(bars):
        for s in range(16):
            t = (lead_in_beats * 4 + b * 16 + s) * step + 0.005
            if s in (0, 8):
                inst.notes.append(pretty_midi.Note(110, 36, t, t + 0.05))
            if s in (4, 12):
                inst.notes.append(pretty_midi.Note(snare_vel, 38, t, t + 0.05))
            if s % 2 == 0:
                inst.notes.append(pretty_midi.Note(70 if s % 4 else 90, 42, t, t + 0.05))
    pm.instruments.append(inst)
    buf = io.BytesIO()
    pm.write(buf)
    return buf.getvalue()


def _zip(tmp: Path) -> Path:
    path = tmp / "groove.zip"
    rows = []
    with zipfile.ZipFile(path, "w") as z:
        for i in range(14):
            for split in ("train", "test"):
                name = f"drummer1/s/{i}_{split}_rock_100_beat_4-4.mid"
                z.writestr(f"groove/{name}", _beat_midi(100, 6, lead_in_beats=i % 3))
                rows.append({"style": "rock/groove", "bpm": "100", "beat_type": "beat", "time_signature": "4-4", "midi_filename": name, "split": split})
        out = io.StringIO()
        w = csv.DictWriter(out, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
        z.writestr("groove/info.csv", out.getvalue())
    return path


def test_phase_alignment_and_core_pattern(tmp_path):
    pm = pretty_midi.PrettyMIDI(io.BytesIO(_beat_midi(100, 4, lead_in_beats=1)))
    bars = tg.bars_of(pm, 100)
    assert bars and all(sorted(s for s, _, _ in b["snare"]) == [4, 12] for b in bars)
    key = tg.core_key(bars, tg.PATTERN_LANES)
    assert tg.to_steps(key[0]) == [0, 8] and tg.to_steps(key[1]) == [4, 12]


def test_train_writes_model(tmp_path):
    out = tmp_path / "model.json"
    assert tg.main(["--zip", str(_zip(tmp_path)), "--out", str(out)]) == 0
    m = json.loads(out.read_text(encoding="utf-8"))
    pop = m["styles"]["pop"]
    assert pop["patterns"][0]["kick"] == [0, 8] and pop["patterns"][0]["snare"] == [4, 12]
    # Hi-hat nhấn ở phách (90) mạnh hơn nốt giữa phách (70).
    vel = pop["feel"]["hihat-close"]["vel"]
    assert vel[0] > vel[2]
