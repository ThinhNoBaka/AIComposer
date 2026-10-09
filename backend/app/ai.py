"""Viết lời và hiểu lệnh tiếng Việt bằng Claude (Anthropic API).

Chỉ bật khi máy chủ có biến môi trường ANTHROPIC_API_KEY (đặt trong Render > Environment, không để trong code).
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
from pydantic import BaseModel, Field

AI_MODEL = os.environ.get("AI_MODEL", "claude-opus-5-5")
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


def available() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


@lru_cache(maxsize=1)
def _client() -> anthropic.Anthropic:
    return anthropic.Anthropic(max_retries=2, timeout=90.0)


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


# ---------- Gọi Claude ----------


def _call(system: str, user: str, schema: type[BaseModel], effort: str, max_tokens: int) -> BaseModel:
    if not available():
        raise AIUnavailable()
    try:
        resp = _client().messages.parse(
            model=AI_MODEL,
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
