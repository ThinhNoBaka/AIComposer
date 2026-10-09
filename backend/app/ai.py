"""Viết lời và hiểu lệnh tiếng Việt bằng AI.

Bật khi máy chủ có một trong các khoá sau (đặt trong Render > Environment, không để trong code):
- GEMINI_API_KEY: Gemini của Google (có gói miễn phí, lấy khoá ở aistudio.google.com)
- GROQ_API_KEY: Groq (có gói miễn phí, console.groq.com)
- ANTHROPIC_API_KEY: Claude (trả tiền theo lượt)
- AI_API_KEY + AI_BASE_URL: dịch vụ bất kỳ có API kiểu OpenAI (OpenRouter, máy tự chạy...)
Có nhiều khoá thì AI_PROVIDER chọn (gemini, groq, anthropic, openai); không đặt thì lấy theo thứ tự trên.
Không có khoá thì /api/ai/status trả available=false và giao diện ẩn các nút AI, mọi thứ khác vẫn chạy.

Lệnh: AI không tự sửa bài. Nó chỉ dịch câu nói tự do của người dùng thành các câu lệnh ngắn mà bộ hiểu lệnh có sẵn
ở giao diện (frontend/src/core/commands.ts) đã biết, nên khoá nốt, khoá giai điệu, giới hạn tempo... vẫn áp dụng y như gõ tay.
"""

from __future__ import annotations

import json
import os
import threading
import time
from functools import lru_cache
from pathlib import Path

import anthropic
import httpx
from pydantic import BaseModel, Field, ValidationError

# Mỗi khoá người dùng và cả máy chủ chỉ được gọi AI chừng này lần mỗi ngày, để người lạ vào web không tiêu hết tiền API.
DAILY_LIMIT_PER_USER = int(os.environ.get("AI_DAILY_LIMIT", "60"))
DAILY_LIMIT_TOTAL = int(os.environ.get("AI_DAILY_LIMIT_TOTAL", "400"))


class AIUnavailable(Exception):
    """Máy chủ chưa có khoá API."""


class AIError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


# Nhà cung cấp có API kiểu OpenAI (/chat/completions): biến chứa khoá, địa chỉ, model mặc định.
OPENAI_STYLE = {
    "gemini": ("GEMINI_API_KEY", "https://generativelanguage.googleapis.com/v1beta/openai", "gemini-flash-latest"),
    "groq": ("GROQ_API_KEY", "https://api.groq.com/openai/v1", "openai/gpt-oss-120b"),
    "openai": ("AI_API_KEY", None, None),
}
ANTHROPIC_MODEL = "claude-opus-5-5"
ORDER = ["gemini", "groq", "anthropic", "openai"]


def _has_key(name: str) -> bool:
    if name == "anthropic":
        return bool(os.environ.get("ANTHROPIC_API_KEY"))
    key_env, base, _ = OPENAI_STYLE[name]
    return bool(os.environ.get(key_env)) and bool(base or os.environ.get("AI_BASE_URL"))


def provider() -> str | None:
    """Nhà cung cấp đang dùng, None nếu chưa có khoá nào."""
    want = os.environ.get("AI_PROVIDER", "").strip().lower()
    if want:
        return want if want in ORDER and _has_key(want) else None
    return next((p for p in ORDER if _has_key(p)), None)


def available() -> bool:
    return provider() is not None


def model_name(p: str) -> str:
    if os.environ.get("AI_MODEL"):
        return os.environ["AI_MODEL"]
    return ANTHROPIC_MODEL if p == "anthropic" else OPENAI_STYLE[p][2] or "gpt-4o-mini"


@lru_cache(maxsize=1)
def _client() -> anthropic.Anthropic:
    return anthropic.Anthropic(max_retries=2, timeout=90.0)


def _http() -> httpx.Client:
    return httpx.Client(timeout=90.0)


# ---------- Giới hạn số lần gọi mỗi ngày ----------

_lock = threading.Lock()
_day = ""
_counts: dict[str, int] = {}


def take_quota(owner: str) -> None:
    global _day
    today = time.strftime("%Y-%m-%d", time.gmtime())
    with _lock:
        if today != _day:
            _day = today
            _counts.clear()
        total = sum(_counts.values())
        if total >= DAILY_LIMIT_TOTAL:
            raise AIError(429, "Hôm nay máy chủ đã dùng hết lượt AI. Mai thử lại nhé.")
        if _counts.get(owner, 0) >= DAILY_LIMIT_PER_USER:
            raise AIError(429, f"Hôm nay bạn đã dùng hết {DAILY_LIMIT_PER_USER} lượt AI. Mai thử lại nhé.")
        _counts[owner] = _counts.get(owner, 0) + 1


def _reset_quota() -> None:  # dùng trong test
    global _day
    with _lock:
        _day = ""
        _counts.clear()


# ---------- Gọi AI ----------


def _call(system: str, user: str, schema: type[BaseModel], effort: str, max_tokens: int) -> BaseModel:
    p = provider()
    if p is None:
        raise AIUnavailable()
    if p != "anthropic":
        return _call_openai_style(p, system, user, schema, max_tokens)
    try:
        resp = _client().messages.parse(
            model=model_name(p),
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
            output_format=schema,
            output_config={"effort": effort},
        )
    except anthropic.AuthenticationError as e:
        raise AIError(503, "Khoá API trên máy chủ không hợp lệ. Kiểm tra lại ANTHROPIC_API_KEY.") from e
    except anthropic.PermissionDeniedError as e:
        raise AIError(503, "Khoá API trên máy chủ không được dùng model này.") from e
    except anthropic.RateLimitError as e:
        raise AIError(429, "AI đang quá tải hoặc hết hạn mức. Thử lại sau ít phút.") from e
    except anthropic.BadRequestError as e:
        raise AIError(502, f"AI từ chối yêu cầu: {e.message}") from e
    except anthropic.APIStatusError as e:
        raise AIError(502, f"AI đang lỗi ({e.status_code}). Thử lại sau.") from e
    except anthropic.APIConnectionError as e:
        raise AIError(502, "Máy chủ không kết nối được tới AI.") from e

    if resp.stop_reason == "refusal":
        raise AIError(422, "AI không viết nội dung này. Thử đổi chủ đề khác.")
    if resp.stop_reason == "max_tokens" or resp.parsed_output is None:
        raise AIError(502, "AI trả lời chưa trọn. Thử lại, hoặc xin ít câu hơn.")
    return resp.parsed_output


def _json_from(text: str) -> str:
    """Model miễn phí đôi khi bọc JSON trong ```json ... ``` hoặc nói thêm vài chữ: lấy phần từ { đầu tới } cuối."""
    a, b = text.find("{"), text.rfind("}")
    return text[a : b + 1] if a >= 0 and b > a else text


def _call_openai_style(p: str, system: str, user: str, schema: type[BaseModel], max_tokens: int) -> BaseModel:
    """Gemini, Groq, OpenRouter...: gọi /chat/completions ở chế độ JSON, rồi kiểm bằng Pydantic. Sai dạng thì nhờ sửa một lần."""
    key_env, base, _ = OPENAI_STYLE[p]
    url = (base or os.environ.get("AI_BASE_URL", "")).rstrip("/") + "/chat/completions"
    shape = json.dumps(schema.model_json_schema(), ensure_ascii=False)
    messages = [
        {"role": "system", "content": f"{system}\n\nChỉ trả lời bằng một đối tượng JSON đúng lược đồ sau, không thêm chữ nào khác:\n{shape}"},
        {"role": "user", "content": user},
    ]
    headers = {"Authorization": f"Bearer {os.environ[key_env]}"}
    json_mode = True
    with _http() as http:
        for attempt in range(2):
            body = {"model": model_name(p), "messages": messages, "max_tokens": max_tokens}
            if json_mode:
                body["response_format"] = {"type": "json_object"}
            try:
                r = http.post(url, json=body, headers=headers)
                if r.status_code == 400 and json_mode:
                    # Vài model không nhận chế độ JSON: gọi lại không có nó, lời dặn trong system vẫn đòi JSON.
                    json_mode = False
                    body = {k: v for k, v in body.items() if k != "response_format"}
                    r = http.post(url, json=body, headers=headers)
            except httpx.HTTPError as e:
                raise AIError(502, "Máy chủ không kết nối được tới AI.") from e
            if r.status_code in (401, 403):
                raise AIError(503, f"Khoá API trên máy chủ không hợp lệ. Kiểm tra lại {key_env}.")
            if r.status_code == 429:
                raise AIError(429, "Đã hết lượt miễn phí của AI trong lúc này. Thử lại sau ít phút.")
            if r.status_code >= 400:
                raise AIError(502, f"AI đang lỗi ({r.status_code}). Thử lại sau, hoặc đổi AI_MODEL.")
            try:
                choice = r.json()["choices"][0]
                text = choice["message"]["content"] or ""
            except (ValueError, KeyError, IndexError, TypeError) as e:
                raise AIError(502, "AI trả về dữ liệu lạ.") from e
            if choice.get("finish_reason") == "content_filter":
                raise AIError(422, "AI không viết nội dung này. Thử đổi chủ đề khác.")
            try:
                return schema.model_validate_json(_json_from(text))
            except ValidationError as e:
                if attempt:
                    raise AIError(502, "AI trả lời sai dạng. Thử lại.") from e
                messages += [
                    {"role": "assistant", "content": text},
                    {"role": "user", "content": f"Câu trả lời chưa đúng lược đồ JSON ({e.errors()[0]['msg']}). Trả lại đúng JSON."},
                ]
    raise AIError(502, "AI trả lời sai dạng. Thử lại.")


# ---------- Viết lời ----------


class LyricsOut(BaseModel):
    lines: list[str] = Field(description="Các câu hát, mỗi phần tử một câu, theo đúng thứ tự")
    title: str = Field(description="Tên bài gợi ý, ngắn")


LYRICS_SYSTEM = """Bạn là người viết lời bài hát tiếng Việt cho một ứng dụng giúp người không biết nhạc lý sáng tác.

Luật bắt buộc:
- Lời phải do bạn tự viết mới hoàn toàn. Không chép, không trích, không sửa nhẹ lời của bất kỳ bài hát có thật nào, \
kể cả khi người dùng nhắc tên bài hay tên ca sĩ: khi đó chỉ lấy chủ đề, cảm xúc làm cảm hứng rồi viết lời mới.
- Mỗi chữ tiếng Việt là một âm tiết, hát trên một nốt. Câu thứ i phải có ĐÚNG số chữ được yêu cầu cho câu đó. \
Đếm lại từng câu trước khi trả lời. Không dùng số, ký hiệu, tiếng Anh hay dấu câu giữa câu.
- Có hướng giai điệu cho từng câu thì chọn chữ có thanh hợp hướng: chỗ giai điệu đi lên ưu tiên thanh sắc, ngang, ngã; \
chỗ đi xuống ưu tiên thanh huyền, nặng, hỏi. Để người nghe không nghe nhầm chữ.
- Gieo vần ở chữ cuối các câu (thường câu chẵn vần với nhau), lời tự nhiên, có hình ảnh, hát được.
- Không viết nhãn như [Điệp khúc] trong câu hát."""


def _contour_text(contour: list[int]) -> str:
    if not contour:
        return ""
    marks = ["lên" if d > 0 else "xuống" if d < 0 else "ngang" for d in contour]
    return " (hướng giai điệu từ chữ 2 trở đi: " + ", ".join(marks) + ")"


def count_syllables(line: str) -> int:
    return len([w for w in line.split() if any(ch.isalpha() for ch in w)])


def write_lyrics(
    topic: str,
    mood: str | None,
    line_syllables: list[int],
    contours: list[list[int]] | None,
    before: str | None,
) -> LyricsOut:
    spec = []
    for i, n in enumerate(line_syllables):
        c = contours[i] if contours and i < len(contours) else []
        spec.append(f"Câu {i + 1}: {n} chữ{_contour_text(c)}")
    parts = [f"Chủ đề: {topic.strip() or 'tự chọn'}"]
    if mood:
        parts.append(f"Cảm xúc: {mood}")
    if before and before.strip():
        parts.append("Lời đã có ở phía trước (viết TIẾP cho liền ý, không lặp lại):\n" + before.strip())
    parts.append(f"Cần {len(line_syllables)} câu:\n" + "\n".join(spec))
    user = "\n\n".join(parts)
    out = _call(LYRICS_SYSTEM, user, LyricsOut, effort="medium", max_tokens=8000)
    assert isinstance(out, LyricsOut)
    out.lines = _clean(out.lines, len(line_syllables))
    wrong = _miscounted(out.lines, line_syllables)
    if wrong:
        # Sai số chữ thì chữ không khớp nốt: nhờ sửa đúng một lần, chỉ các câu sai.
        fix = "\n".join(f"Câu {i + 1} đang có {count_syllables(out.lines[i]) if i < len(out.lines) else 0} chữ, cần {line_syllables[i]} chữ." for i in wrong)
        draft = "\n".join(f"{i + 1}. {t}" for i, t in enumerate(out.lines))
        again = _call(
            LYRICS_SYSTEM,
            f"{user}\n\nBản nháp:\n{draft}\n\n{fix}\nViết lại toàn bộ cho đúng số chữ, giữ nguyên các câu đã đúng.",
            LyricsOut,
            effort="low",
            max_tokens=8000,
        )
        assert isinstance(again, LyricsOut)
        lines = _clean(again.lines, len(line_syllables))
        if len(_miscounted(lines, line_syllables)) < len(wrong):
            out.lines = lines
    return out


def _clean(lines: list[str], n: int) -> list[str]:
    return [" ".join(line.split()) for line in lines if line.strip()][:n]


def _miscounted(lines: list[str], want: list[int]) -> list[int]:
    return [i for i, n in enumerate(want) if i >= len(lines) or count_syllables(lines[i]) != n]


# ---------- Hiểu lệnh ----------


class CommandOut(BaseModel):
    commands: list[str] = Field(description="Các câu lệnh ngắn trong danh sách được phép, theo thứ tự cần làm")
    reply: str = Field(description="Một câu ngắn tiếng Việt nói lại sẽ làm gì, hoặc vì sao không làm được")


def _command_system() -> str:
    data = json.loads((Path(__file__).with_name("ai_commands.json")).read_text(encoding="utf-8"))
    groups = "\n".join(f"{g['name']}: " + ", ".join(f'"{e}"' for e in g["examples"]) for g in data["groups"])
    return (
        "Bạn là bộ hiểu lệnh của một ứng dụng sáng tác nhạc. Người dùng nói tiếng Việt tự do; bạn dịch thành các câu lệnh "
        "ngắn mà ứng dụng hiểu. Chỉ được dùng đúng các mẫu dưới đây (được thay số, tên giọng, tên nhạc cụ cho hợp):\n\n"
        f"{groups}\n\n"
        "Mỗi phần tử của commands là MỘT mẫu như trên. Ý nào không khớp mẫu nào thì bỏ qua và nói rõ trong reply. "
        'Không bịa lệnh mới. Ví dụ "làm cho nó buồn và chậm như mưa" thành ["đổi sang buồn", "chậm lại"].'
    )


def understand_command(text: str, context: str | None) -> CommandOut:
    user = f"Bài đang có: {context}\n\nNgười dùng nói: {text}" if context else f"Người dùng nói: {text}"
    out = _call(_command_system(), user, CommandOut, effort="low", max_tokens=4000)
    assert isinstance(out, CommandOut)
    out.commands = [c.strip() for c in out.commands if c.strip()][:8]
    return out
