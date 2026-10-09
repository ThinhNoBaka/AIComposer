"""API AI: không gọi mạng thật, thay client Anthropic bằng bản giả."""

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import ai
from app.main import app

ALICE = {"X-Owner-Key": "alice-secret-key-123456"}


class FakeMessages:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []

    def parse(self, **kw):
        self.calls.append(kw)
        out = self.replies.pop(0)
        if isinstance(out, Exception):
            raise out
        if out == "refusal":
            return SimpleNamespace(stop_reason="refusal", parsed_output=None)
        return SimpleNamespace(stop_reason="end_turn", parsed_output=kw["output_format"](**out))


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture
def fake(monkeypatch):
    def install(*replies):
        msgs = FakeMessages(replies)
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
        monkeypatch.setattr(ai, "_client", lambda: SimpleNamespace(messages=msgs))
        ai._reset_quota()
        return msgs

    return install


def test_status_without_key(client, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert client.get("/api/ai/status").json() == {"available": False}
    r = client.post("/api/ai/lyrics", json={"topic": "mưa", "line_syllables": [4]}, headers=ALICE)
    assert r.status_code == 503


def test_lyrics_counts_and_prompt(client, fake):
    msgs = fake({"title": "Mưa", "lines": ["chiều nay mưa rơi", "em  đi qua phố cũ"]})
    r = client.post(
        "/api/ai/lyrics",
        json={"topic": "mưa", "mood": "buồn", "line_syllables": [4, 5], "contours": [[2, -1, 0], []]},
        headers=ALICE,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["lines"] == [
        {"text": "chiều nay mưa rơi", "syllables": 4, "wanted": 4},
        {"text": "em đi qua phố cũ", "syllables": 5, "wanted": 5},
    ]
    assert len(msgs.calls) == 1
    call = msgs.calls[0]
    assert call["model"] == ai.AI_MODEL and call["output_config"] == {"effort": "medium"}
    assert "Câu 1: 4 chữ (hướng giai điệu từ chữ 2 trở đi: lên, xuống, ngang)" in call["messages"][0]["content"]
    assert "Không chép" in call["system"]


def test_lyrics_repairs_wrong_count_once(client, fake):
    msgs = fake({"title": "A", "lines": ["một hai ba", "bốn năm"]}, {"title": "A", "lines": ["một hai ba bốn", "bốn năm"]})
    r = client.post("/api/ai/lyrics", json={"line_syllables": [4, 2]}, headers=ALICE)
    assert r.status_code == 200
    assert [x["syllables"] for x in r.json()["lines"]] == [4, 2]
    assert len(msgs.calls) == 2 and "Câu 1 đang có 3 chữ, cần 4 chữ." in msgs.calls[1]["messages"][0]["content"]


def test_refusal_and_api_errors(client, fake):
    fake("refusal")
    r = client.post("/api/ai/lyrics", json={"line_syllables": [4]}, headers=ALICE)
    assert r.status_code == 422
    req = SimpleNamespace(method="POST", url="https://api.anthropic.com/v1/messages", headers={})
    import anthropic
    import httpx

    err = anthropic.AuthenticationError("bad key", response=httpx.Response(401, request=httpx.Request("POST", req.url)), body=None)
    fake(err)
    r = client.post("/api/ai/command", json={"text": "cho buồn hơn"}, headers=ALICE)
    assert r.status_code == 503 and "ANTHROPIC_API_KEY" in r.json()["detail"]


def test_command(client, fake):
    msgs = fake({"commands": ["đổi sang buồn", " chậm lại ", ""], "reply": "Đổi sang buồn và chậm lại."})
    r = client.post("/api/ai/command", json={"text": "làm cho nó buồn như mưa", "context": "tempo 100"}, headers=ALICE)
    assert r.status_code == 200
    assert r.json() == {"commands": ["đổi sang buồn", "chậm lại"], "reply": "Đổi sang buồn và chậm lại."}
    sysmsg = msgs.calls[0]["system"]
    assert '"đổi sang buồn"' in sysmsg and '"giai điệu dùng sáo trúc"' in sysmsg
    assert msgs.calls[0]["output_config"] == {"effort": "low"}


def test_daily_quota(client, fake, monkeypatch):
    monkeypatch.setattr(ai, "DAILY_LIMIT_PER_USER", 1)
    fake({"commands": [], "reply": "Chưa hiểu."})
    assert client.post("/api/ai/command", json={"text": "abc"}, headers=ALICE).status_code == 200
    assert client.post("/api/ai/command", json={"text": "abc"}, headers=ALICE).status_code == 429
    assert client.post("/api/ai/command", json={"text": "abc"}).status_code == 401
