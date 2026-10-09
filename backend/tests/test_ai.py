"""API AI: không gọi mạng thật, thay client Anthropic / client HTTP bằng bản giả."""

import json
from types import SimpleNamespace

import httpx
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


KEYS = ["GEMINI_API_KEY", "GROQ_API_KEY", "ANTHROPIC_API_KEY", "AI_API_KEY", "AI_BASE_URL", "AI_PROVIDER", "AI_MODEL"]


@pytest.fixture(autouse=True)
def no_keys(monkeypatch):
    for k in KEYS:
        monkeypatch.delenv(k, raising=False)


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
    assert client.get("/api/ai/status").json() == {"available": False, "provider": None}
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
    assert call["model"] == "claude-opus-5-5" and call["output_config"] == {"effort": "medium"}
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


# ---------- Gemini / Groq / API kiểu OpenAI ----------


class FakeHTTP:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def post(self, url, json=None, headers=None):
        self.calls.append({"url": url, "json": json, "headers": headers})
        out = self.responses.pop(0)
        if isinstance(out, Exception):
            raise out
        if isinstance(out, int):
            return httpx.Response(out, json={"error": {"message": "x"}})
        return httpx.Response(200, json={"choices": [{"message": {"content": out}, "finish_reason": "stop"}]})


@pytest.fixture
def gemini(monkeypatch):
    def install(*responses):
        http = FakeHTTP(responses)
        monkeypatch.setenv("GEMINI_API_KEY", "g-test")
        monkeypatch.setattr(ai, "_http", lambda: http)
        ai._reset_quota()
        return http

    return install


def test_provider_order_and_override(client, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "a")
    assert ai.provider() == "anthropic"
    monkeypatch.setenv("GROQ_API_KEY", "q")
    assert ai.provider() == "groq"
    monkeypatch.setenv("GEMINI_API_KEY", "g")
    assert ai.provider() == "gemini" and ai.model_name("gemini") == "gemini-flash-latest"
    monkeypatch.setenv("AI_PROVIDER", "anthropic")
    assert client.get("/api/ai/status").json() == {"available": True, "provider": "anthropic"}
    monkeypatch.setenv("AI_PROVIDER", "openai")  # chọn nhưng chưa có khoá
    assert ai.provider() is None
    monkeypatch.setenv("AI_API_KEY", "k")
    assert ai.provider() is None  # thiếu AI_BASE_URL
    monkeypatch.setenv("AI_BASE_URL", "https://openrouter.ai/api/v1")
    monkeypatch.setenv("AI_MODEL", "meta/llama")
    assert ai.provider() == "openai" and ai.model_name("openai") == "meta/llama"


def test_gemini_lyrics(client, gemini):
    http = gemini('```json\n{"title": "Mưa", "lines": ["chiều nay mưa rơi"]}\n```')
    r = client.post("/api/ai/lyrics", json={"topic": "mưa", "line_syllables": [4]}, headers=ALICE)
    assert r.status_code == 200, r.text
    assert r.json()["lines"] == [{"text": "chiều nay mưa rơi", "syllables": 4, "wanted": 4}]
    call = http.calls[0]
    assert call["url"] == "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
    assert call["headers"]["Authorization"] == "Bearer g-test"
    body = call["json"]
    assert body["model"] == "gemini-flash-latest" and body["response_format"] == {"type": "json_object"}
    assert "Không chép" in body["messages"][0]["content"] and '"lines"' in body["messages"][0]["content"]
    assert "Câu 1: 4 chữ" in body["messages"][1]["content"]


def test_bad_json_retried_once(client, gemini):
    good = json.dumps({"commands": ["chậm lại"], "reply": "Chậm lại."}, ensure_ascii=False)
    http = gemini("tôi nghĩ là chậm lại", good)
    r = client.post("/api/ai/command", json={"text": "chậm chút"}, headers=ALICE)
    assert r.status_code == 200 and r.json()["commands"] == ["chậm lại"]
    msgs = http.calls[1]["json"]["messages"]
    assert msgs[-2] == {"role": "assistant", "content": "tôi nghĩ là chậm lại"} and "JSON" in msgs[-1]["content"]

    gemini("sai", "vẫn sai")
    assert client.post("/api/ai/command", json={"text": "x"}, headers=ALICE).status_code == 502


def test_json_mode_not_supported(client, gemini):
    http = gemini(400, '{"commands": [], "reply": "Chưa hiểu."}')
    r = client.post("/api/ai/command", json={"text": "x"}, headers=ALICE)
    assert r.status_code == 200
    assert "response_format" in http.calls[0]["json"] and "response_format" not in http.calls[1]["json"]


def test_openai_style_errors(client, gemini):
    gemini(401)
    r = client.post("/api/ai/command", json={"text": "x"}, headers=ALICE)
    assert r.status_code == 503 and "GEMINI_API_KEY" in r.json()["detail"]
    gemini(429)
    r = client.post("/api/ai/command", json={"text": "x"}, headers=ALICE)
    assert r.status_code == 429 and "miễn phí" in r.json()["detail"]
    gemini(500)
    assert client.post("/api/ai/command", json={"text": "x"}, headers=ALICE).status_code == 502
    gemini(httpx.ConnectError("down"))
    assert client.post("/api/ai/command", json={"text": "x"}, headers=ALICE).status_code == 502
