import pytest
from fastapi.testclient import TestClient

from app.humming.synth import synth_hum, to_wav_bytes
from app.main import app

ALICE = {"X-Owner-Key": "alice-secret-key-123456"}
BOB = {"X-Owner-Key": "bob-secret-key-abcdefgh"}

SONG = {"version": 1, "title": "Thử", "melody": [], "chords": [{"degree": 0, "seventh": False}], "bars": 1}


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json()["ok"] is True


def test_requires_owner_key(client):
    assert client.get("/api/projects").status_code == 401
    assert client.get("/api/projects", headers={"X-Owner-Key": "short"}).status_code == 401


def test_project_crud_and_isolation(client):
    r = client.post("/api/projects", json={"title": "Bài 1", "song": SONG}, headers=ALICE)
    assert r.status_code == 201
    pid = r.json()["id"]
    assert [p["id"] for p in client.get("/api/projects", headers=ALICE).json()] == [pid]
    # người khác không thấy, không sửa, không xoá được
    assert client.get("/api/projects", headers=BOB).json() == []
    assert client.get(f"/api/projects/{pid}", headers=BOB).status_code == 404
    assert client.put(f"/api/projects/{pid}", json={"title": "x", "song": SONG}, headers=BOB).status_code == 404
    assert client.delete(f"/api/projects/{pid}", headers=BOB).status_code == 404
    r = client.put(f"/api/projects/{pid}", json={"title": "Bài 1 sửa", "song": {**SONG, "bpm": 90}}, headers=ALICE)
    assert r.json()["title"] == "Bài 1 sửa" and r.json()["song"]["bpm"] == 90
    assert client.delete(f"/api/projects/{pid}", headers=ALICE).status_code == 204
    assert client.get(f"/api/projects/{pid}", headers=ALICE).status_code == 404


def test_rejects_invalid_song(client):
    assert client.post("/api/projects", json={"title": "x", "song": {"version": 2}}, headers=ALICE).status_code == 422


def test_humming_upload_returns_melody_and_is_stored(client):
    beat = 60 / 100
    ref = [(0.3 + i * beat, 0.3 + (i + 1) * beat - 0.06, p) for i, p in enumerate([60, 62, 64, 65, 67])]
    wav = to_wav_bytes(synth_hum(ref, 16000, seed=1))
    pid = client.post("/api/projects", json={"title": "Hum", "song": SONG}, headers=ALICE).json()["id"]
    r = client.post(
        "/api/humming",
        files={"audio": ("hum.wav", wav, "audio/wav")},
        data={"bpm": "100", "project_id": pid},
        headers=ALICE,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert [m["pitch"] % 12 for m in body["melody"]] == [0, 2, 4, 5, 7]
    assert [m["start"] for m in body["melody"]] == [0, 4, 8, 12, 16]
    assert body["tonic"] == 0 and body["mode"] == "major"
    recs = client.get("/api/humming/recordings", headers=ALICE).json()
    assert any(x["id"] == body["recording_id"] and x["project_id"] == pid for x in recs)
    assert client.get("/api/humming/recordings", headers=BOB).json() == []


def test_humming_rejects_bad_input(client):
    assert client.post("/api/humming", files={"audio": ("x.wav", b"not audio", "audio/wav")}, headers=ALICE).status_code == 400
    wav = to_wav_bytes(synth_hum([(0.1, 0.5, 60)], 16000))
    assert client.post("/api/humming", files={"audio": ("x.wav", wav, "audio/wav")}, data={"bpm": "500"}, headers=ALICE).status_code == 422
    assert client.post("/api/humming", files={"audio": ("x.wav", wav, "audio/wav")}, data={"tonic": "3"}, headers=ALICE).status_code == 422
    other = client.post("/api/projects", json={"title": "B", "song": SONG}, headers=BOB).json()["id"]
    r = client.post("/api/humming", files={"audio": ("x.wav", wav, "audio/wav")}, data={"project_id": other}, headers=ALICE)
    assert r.status_code == 404


def test_unknown_api_is_404(client):
    assert client.get("/api/khong-co").status_code == 404


def test_timestamps_have_timezone(client):
    h = {"X-Owner-Key": "k" * 20}
    r = client.post("/api/projects", json={"title": "Giờ", "song": {"version": 1, "melody": [], "chords": []}}, headers=h)
    assert r.json()["updated_at"].endswith(("Z", "+00:00"))
    assert client.get("/api/projects", headers=h).json()[0]["updated_at"].endswith(("Z", "+00:00"))


def test_project_revisions_and_restore(client):
    pid = client.post("/api/projects", json={"title": "V", "song": {**SONG, "bpm": 80}}, headers=ALICE).json()["id"]
    assert client.get(f"/api/projects/{pid}/revisions", headers=ALICE).json() == []
    client.put(f"/api/projects/{pid}", json={"title": "V", "song": {**SONG, "bpm": 90}}, headers=ALICE)
    client.put(f"/api/projects/{pid}", json={"title": "V", "song": {**SONG, "bpm": 90}}, headers=ALICE)  # không đổi: không thêm bản
    client.put(f"/api/projects/{pid}", json={"title": "V2", "song": {**SONG, "bpm": 100}}, headers=ALICE)
    revs = client.get(f"/api/projects/{pid}/revisions", headers=ALICE).json()
    assert len(revs) == 2
    assert client.get(f"/api/projects/{pid}/revisions", headers=BOB).status_code == 404
    oldest = revs[-1]  # mới nhất trước: bản cuối danh sách là bản bpm 80 lưu lúc tạo bài
    assert oldest["title"] == "V" and oldest["notes"] == 0 and oldest["bars"] == 1
    r = client.post(f"/api/projects/{pid}/revisions/{oldest['id']}/restore", headers=ALICE)
    assert r.status_code == 200 and r.json()["song"]["bpm"] == 80 and r.json()["title"] == "V"
    # bản bpm 100 đang có trước khi khôi phục đã được giữ lại
    revs = client.get(f"/api/projects/{pid}/revisions", headers=ALICE).json()
    assert len(revs) == 3
    assert client.post(f"/api/projects/{pid}/revisions/{oldest['id']}/restore", headers=BOB).status_code == 404
    assert client.post(f"/api/projects/{pid}/revisions/khong-co/restore", headers=ALICE).status_code == 404
    assert client.delete(f"/api/projects/{pid}", headers=ALICE).status_code == 204


def test_revisions_are_capped(client, monkeypatch):
    from app.routes import projects

    monkeypatch.setattr(projects, "MAX_REVISIONS", 3)
    pid = client.post("/api/projects", json={"title": "C", "song": SONG}, headers=ALICE).json()["id"]
    for bpm in range(100, 106):
        client.put(f"/api/projects/{pid}", json={"title": "C", "song": {**SONG, "bpm": bpm}}, headers=ALICE)
    assert len(client.get(f"/api/projects/{pid}/revisions", headers=ALICE).json()) == 3


def test_humming_job_runs_in_background_and_reports_result(client):
    import time

    beat = 60 / 100
    ref = [(0.3 + i * beat, 0.3 + (i + 1) * beat - 0.06, p) for i, p in enumerate([60, 64, 67])]
    wav = to_wav_bytes(synth_hum(ref, 16000, seed=2))
    assert client.get("/api/humming/limits").json()["max_minutes"] > 1
    r = client.post("/api/humming/jobs", files={"audio": ("hum.wav", wav, "audio/wav")}, data={"bpm": "100"}, headers=ALICE)
    assert r.status_code == 200, r.text
    job = r.json()
    assert client.get(f"/api/humming/jobs/{job['job_id']}", headers=BOB).status_code == 404
    for _ in range(300):
        job = client.get(f"/api/humming/jobs/{job['job_id']}", headers=ALICE).json()
        if job["status"] in ("done", "error"):
            break
        time.sleep(0.1)
    assert job["status"] == "done" and job["progress"] == 1.0
    assert [m["pitch"] % 12 for m in job["result"]["melody"]] == [0, 4, 7]
    assert job["result"]["truncated"] is False

    bad = client.post("/api/humming/jobs", files={"audio": ("x.wav", b"not audio", "audio/wav")}, headers=ALICE).json()
    for _ in range(100):
        bad = client.get(f"/api/humming/jobs/{bad['job_id']}", headers=ALICE).json()
        if bad["status"] in ("done", "error"):
            break
        time.sleep(0.1)
    assert bad["status"] == "error" and "giải mã" in bad["error"]


def test_humming_upload_size_limit(client, monkeypatch):
    from app.routes import humming

    monkeypatch.setattr(humming, "HUM_MAX_UPLOAD_MB", 0.5)
    big = b"\0" * (600 * 1024)
    r = client.post("/api/humming/jobs", files={"audio": ("big.wav", big, "audio/wav")}, headers=ALICE)
    assert r.status_code == 413 and "0.5 MB" in r.json()["detail"]
