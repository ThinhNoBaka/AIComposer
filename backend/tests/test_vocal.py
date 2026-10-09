import io
import os
import subprocess
import time

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from app.main import app
from app.vocal.correct import CorrectionParams, analyze, correct_vocal
from app.vocal.psola import psola_shift

ALICE = {"X-Owner-Key": "alice-vocal-key-1234567"}
BOB = {"X-Owner-Key": "bob-vocal-key-abcdefghij"}
SONG = {"version": 1, "title": "Thử", "melody": [], "chords": [{"degree": 0, "seventh": False}], "bars": 1}
A_MAJOR = {"tonic": 9, "scale": "major"}


def sing(segments, sr=44100, vibrato_cents=15.0, pad=0.3, seed=0):
    """Giọng giả: sóng răng cưa (nhiều hoà âm như giọng thật) có rung 5.5 Hz. segments = [(midi, giây)]."""
    f = []
    for midi, dur in segments:
        t = np.arange(int(dur * sr)) / sr
        f.append(440.0 * 2 ** ((midi - 69 + vibrato_cents / 100 * np.sin(2 * np.pi * 5.5 * t)) / 12))
    f = np.concatenate(f)
    phase = 2 * np.pi * np.cumsum(f) / sr
    y = 0.3 * sum(np.sin(k * phase) / k for k in range(1, 16))
    n = len(y)
    env = np.minimum(1, np.arange(n) / (0.04 * sr)) * np.minimum(1, (n - np.arange(n)) / (0.04 * sr))
    y = y * env + 0.002 * np.random.default_rng(seed).standard_normal(n)
    z = np.zeros(int(pad * sr))
    return np.concatenate([z, y, z]).astype(np.float32)


def pitch_between(y, sr, t0, t1):
    an = analyze(y, sr)
    t = np.arange(len(an.midi)) * an.hop_s
    seg = an.midi[(t >= t0) & (t < t1)]
    return float(np.nanmedian(seg)), float(np.nanstd(seg))


def wav_bytes(y, sr):
    buf = io.BytesIO()
    sf.write(buf, y, sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


# ---------- thuật toán ----------


@pytest.mark.parametrize("sr", [22050, 44100])
def test_scale_mode_pulls_sharp_a4_to_440(sr):
    y = sing([(69.3, 2.0)], sr)  # La 4 cao 30 cent, có rung
    before, _ = pitch_between(y, sr, 0.5, 2.1)
    assert before == pytest.approx(69.3, abs=0.08)
    out, _, corrected = correct_vocal(y, sr, CorrectionParams(strength=1.0, mode="scale", **A_MAJOR))
    assert len(out) == len(y)
    after, _ = pitch_between(out, sr, 0.5, 2.1)
    assert abs(after - 69.0) * 100 < 15
    assert np.nanmedian(corrected) == pytest.approx(69.0, abs=0.05)
    # âm lượng gần như giữ nguyên
    assert np.sqrt(np.mean(out**2) / np.mean(y**2)) == pytest.approx(1.0, abs=0.05)


def test_strength_zero_is_identity_and_half_strength_is_halfway():
    sr = 44100
    y = sing([(69.3, 1.5)], sr)
    out, _, _ = correct_vocal(y, sr, CorrectionParams(strength=0.0, mode="chromatic"))
    assert np.array_equal(out, y)
    half, _ = pitch_between(correct_vocal(y, sr, CorrectionParams(strength=0.5, mode="chromatic"))[0], sr, 0.5, 1.6)
    assert half == pytest.approx(69.15, abs=0.07)


def test_psola_without_shift_returns_input():
    sr = 22050
    y = sing([(60, 1.0)], sr)
    f0 = np.full(150, 261.6)
    assert np.array_equal(psola_shift(y, sr, f0, np.ones(150, bool), f0, 0.01), y)


def test_keep_vibrato_keeps_fast_wobble():
    sr = 22050
    y = sing([(69.3, 2.0)], sr, vibrato_cents=25)
    _, std_keep = pitch_between(correct_vocal(y, sr, CorrectionParams(mode="chromatic", keep_vibrato=True))[0], sr, 0.6, 2.0)
    _, std_flat = pitch_between(correct_vocal(y, sr, CorrectionParams(mode="chromatic", keep_vibrato=False))[0], sr, 0.6, 2.0)
    assert std_keep > 0.12  # rung 25 cent biên độ còn lại (độ lệch chuẩn ~18 cent)
    assert std_flat < 0.08  # bám nốt cứng: gần như phẳng


def test_retune_speed_slows_the_correction():
    sr = 22050
    y = sing([(69.4, 1.5)], sr, vibrato_cents=0)
    _, _, hard = correct_vocal(y, sr, CorrectionParams(mode="chromatic", retune_speed_ms=0))
    _, _, slow = correct_vocal(y, sr, CorrectionParams(mode="chromatic", retune_speed_ms=400))
    # ở đầu nốt, chỉnh chậm còn lệch nhiều hơn chỉnh tức thì
    i = int(0.4 / 0.01)
    assert abs(slow[i] - 69) > abs(hard[i] - 69) + 0.05


def test_melody_mode_follows_given_notes():
    sr = 44100
    # hát La rồi Si, cả hai thấp; giai điệu bảo phải là La# rồi Đô (không thuộc thang nào cụ thể)
    y = sing([(69.4, 1.0), (71.4, 1.0)], sr, vibrato_cents=10)
    notes = [{"pitch": 70, "start_s": 0.3, "end_s": 1.3}, {"pitch": 72, "start_s": 1.3, "end_s": 2.3}]
    out, _, _ = correct_vocal(y, sr, CorrectionParams(mode="melody", notes=notes, **A_MAJOR))
    assert pitch_between(out, sr, 0.5, 1.2)[0] == pytest.approx(70, abs=0.15)
    assert pitch_between(out, sr, 1.5, 2.2)[0] == pytest.approx(72, abs=0.15)


def test_melody_mode_keeps_singer_octave_and_falls_back_to_scale():
    sr = 22050
    y = sing([(57.3, 1.0), (59.3, 1.0)], sr)  # hát thấp một quãng tám
    notes = [{"pitch": 69, "start_s": 0.3, "end_s": 1.3}]  # đoạn sau không có nốt → về thang La trưởng
    out, _, _ = correct_vocal(y, sr, CorrectionParams(mode="melody", notes=notes, **A_MAJOR))
    assert pitch_between(out, sr, 0.5, 1.2)[0] == pytest.approx(57, abs=0.15)
    assert pitch_between(out, sr, 1.5, 2.2)[0] == pytest.approx(59, abs=0.15)


@pytest.mark.parametrize("sr", [22050, 44100])
def test_ten_seconds_runs_fast(sr):
    # Máy CI chậm có thể nới bằng VOCAL_TIMING_FACTOR (vd 3).
    factor = float(os.environ.get("VOCAL_TIMING_FACTOR", "1"))
    y = sing([(60 + (i % 7) + 0.3, 0.7) for i in range(14)], sr)[: 10 * sr]
    correct_vocal(y[: sr], sr, CorrectionParams(mode="chromatic"))  # khởi động numba của pYIN
    t = time.perf_counter()
    out, _, _ = correct_vocal(y, sr, CorrectionParams(mode="chromatic", retune_speed_ms=20))
    elapsed = time.perf_counter() - t
    assert len(out) == len(y)
    assert elapsed < 3.0 * factor, f"{elapsed:.2f}s"


# ---------- API ----------


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def upload(client, data, headers=ALICE, name="take.wav", ctype="audio/wav", **form):
    return client.post("/api/vocal/takes", files={"audio": (name, data, ctype)}, data={k: str(v) for k, v in form.items()}, headers=headers)


def test_upload_correct_listen_delete(client):
    y = sing([(69.3, 1.5)], 48000)
    r = upload(client, wav_bytes(y, 48000), offset_ms=1200, bpm=100)
    assert r.status_code == 201, r.text
    take = r.json()
    assert take["sr"] == 44100 and take["duration_s"] == pytest.approx(len(y) / 48000, abs=0.01)
    tid = take["id"]

    assert client.get(f"/api/vocal/takes/{tid}/audio?version=corrected", headers=ALICE).status_code == 404
    orig = client.get(f"/api/vocal/takes/{tid}/audio", headers=ALICE)
    assert orig.status_code == 200 and orig.headers["content-type"] == "audio/wav"

    body = {"strength": 1, "mode": "scale", "retune_speed_ms": 0, "keep_vibrato": True, "key": {"tonic": 9, "mode": "major"}}
    r = client.post(f"/api/vocal/takes/{tid}/correct", json=body, headers=ALICE)
    assert r.status_code == 200, r.text
    res = r.json()
    assert res["recipe"] == {**{k: body[k] for k in ("strength", "mode", "retune_speed_ms", "keep_vibrato", "key")}, "notes_count": 0}
    f0 = res["f0"]
    assert f0["hop_s"] == 0.01 and len(f0["original"]) == len(f0["corrected"])
    assert len(f0["original"]) == pytest.approx(take["duration_s"] * 100, abs=3)
    voiced = [(o, c) for o, c in zip(f0["original"], f0["corrected"]) if o is not None]
    assert np.median([o for o, _ in voiced]) == pytest.approx(69.3, abs=0.08)
    assert np.median([c for _, c in voiced]) == pytest.approx(69.0, abs=0.03)

    wav = client.get(f"/api/vocal/takes/{tid}/audio?version=corrected", headers=ALICE)
    assert wav.status_code == 200
    out, sr = sf.read(io.BytesIO(wav.content), dtype="float32")
    assert sr == 44100 and abs(pitch_between(out, sr, 0.5, 1.6)[0] - 69) * 100 < 15

    listed = client.get("/api/vocal/takes", headers=ALICE).json()
    row = next(x for x in listed if x["id"] == tid)
    assert row["has_corrected"] and row["recipe"]["mode"] == "scale" and row["offset_ms"] == 1200 and row["bpm"] == 100
    assert row["created_at"].endswith(("Z", "+00:00"))

    # strength 0 → bản "đã chỉnh" trùng từng byte với bản gốc
    r = client.post(f"/api/vocal/takes/{tid}/correct", json={**body, "strength": 0}, headers=ALICE)
    assert r.status_code == 200
    same = client.get(f"/api/vocal/takes/{tid}/audio?version=corrected", headers=ALICE)
    assert same.content == client.get(f"/api/vocal/takes/{tid}/audio?version=original", headers=ALICE).content

    assert client.get(f"/api/vocal/takes/{tid}/audio?version=khac", headers=ALICE).status_code == 422
    assert client.delete(f"/api/vocal/takes/{tid}", headers=ALICE).status_code == 204
    assert client.get(f"/api/vocal/takes/{tid}/audio", headers=ALICE).status_code == 404


def test_melody_notes_use_song_time(client):
    # bản thu bắt đầu ở giây 10 của bài: nốt giai điệu tính theo giờ bài hát
    y = sing([(69.4, 1.0), (71.4, 1.0)], 44100, vibrato_cents=10)
    tid = upload(client, wav_bytes(y, 44100), offset_ms=10000).json()["id"]
    notes = [{"pitch": 70, "start_s": 10.3, "end_s": 11.3}, {"pitch": 72, "start_s": 11.3, "end_s": 12.3}]
    r = client.post(f"/api/vocal/takes/{tid}/correct", json={"mode": "melody", "notes": notes}, headers=ALICE)
    assert r.status_code == 200, r.text
    c = np.array([np.nan if v is None else v for v in r.json()["f0"]["corrected"]])
    assert np.nanmedian(c[50:120]) == pytest.approx(70, abs=0.05)
    assert np.nanmedian(c[150:220]) == pytest.approx(72, abs=0.05)


def test_auth_and_ownership(client):
    wav = wav_bytes(sing([(60, 0.5)], 22050), 22050)
    assert upload(client, wav, headers={}).status_code == 401
    tid = upload(client, wav).json()["id"]
    assert client.get("/api/vocal/takes", headers={}).status_code == 401
    assert all(x["id"] != tid for x in client.get("/api/vocal/takes", headers=BOB).json())
    assert client.get(f"/api/vocal/takes/{tid}/audio", headers=BOB).status_code == 404
    assert client.post(f"/api/vocal/takes/{tid}/correct", json={"mode": "chromatic"}, headers=BOB).status_code == 404
    assert client.delete(f"/api/vocal/takes/{tid}", headers=BOB).status_code == 404
    assert client.get(f"/api/vocal/takes/{tid}/audio", headers=ALICE).status_code == 200
    # không gắn được vào bài của người khác
    other = client.post("/api/projects", json={"title": "B", "song": SONG}, headers=BOB).json()["id"]
    assert upload(client, wav, project_id=other).status_code == 404


def test_takes_by_project_and_cascade_delete(client):
    wav = wav_bytes(sing([(60, 0.5)], 22050), 22050)
    pid = client.post("/api/projects", json={"title": "Hát", "song": SONG}, headers=ALICE).json()["id"]
    tid = upload(client, wav, project_id=pid).json()["id"]
    loose = upload(client, wav).json()["id"]
    assert [x["id"] for x in client.get(f"/api/vocal/takes?project_id={pid}", headers=ALICE).json()] == [tid]
    assert client.delete(f"/api/projects/{pid}", headers=ALICE).status_code == 204
    ids = [x["id"] for x in client.get("/api/vocal/takes", headers=ALICE).json()]
    assert tid not in ids and loose in ids


def test_rejects_bad_requests(client, monkeypatch):
    wav = wav_bytes(sing([(60, 0.5)], 22050), 22050)
    assert upload(client, b"khong phai audio").status_code == 400
    assert upload(client, wav, bpm=500).status_code == 422
    tid = upload(client, wav).json()["id"]
    url = f"/api/vocal/takes/{tid}/correct"
    assert client.post(url, json={"mode": "scale"}, headers=ALICE).status_code == 422  # thiếu giọng
    assert client.post(url, json={"mode": "melody"}, headers=ALICE).status_code == 422  # thiếu nốt và giọng
    assert client.post(url, json={"mode": "auto"}, headers=ALICE).status_code == 422
    assert client.post(url, json={"mode": "chromatic", "strength": 1.5}, headers=ALICE).status_code == 422
    assert client.post(url, json={"mode": "scale", "key": {"tonic": 0, "mode": "lydian"}}, headers=ALICE).status_code == 422
    monkeypatch.setattr("app.routes.vocal.MAX_UPLOAD_MB", 0.01)
    assert upload(client, wav).status_code == 413


def _ffmpeg_with_opus():
    try:
        import imageio_ffmpeg

        exe = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001
        return None
    enc = subprocess.run([exe, "-hide_banner", "-encoders"], capture_output=True, text=True).stdout
    return exe if "libopus" in enc else None


def test_webm_opus_upload_from_browser(client):
    exe = _ffmpeg_with_opus()
    if not exe:
        pytest.skip("Không có ffmpeg kèm libopus để tạo file WebM thử")
    y = sing([(69.3, 1.5)], 48000)
    proc = subprocess.run(
        [exe, "-v", "error", "-f", "f32le", "-ar", "48000", "-ac", "1", "-i", "pipe:0", "-c:a", "libopus", "-b:a", "96k", "-f", "webm", "pipe:1"],
        input=y.tobytes(),
        capture_output=True,
        timeout=60,
    )
    assert proc.returncode == 0 and proc.stdout[:4] == b"\x1a\x45\xdf\xa3", proc.stderr[-300:]
    r = upload(client, proc.stdout, name="take.webm", ctype="audio/webm;codecs=opus")
    assert r.status_code == 201, r.text
    assert r.json()["duration_s"] == pytest.approx(len(y) / 48000, abs=0.05)
    res = client.post(f"/api/vocal/takes/{r.json()['id']}/correct", json={"mode": "chromatic"}, headers=ALICE).json()
    assert np.median([c for c in res["f0"]["corrected"] if c is not None]) == pytest.approx(69.0, abs=0.05)
