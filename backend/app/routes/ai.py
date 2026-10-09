"""API viết lời và hiểu lệnh bằng AI. Xem app/ai.py."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import ai
from ..deps import owner_id

router = APIRouter(prefix="/api/ai", tags=["ai"])


class LyricsRequest(BaseModel):
    topic: str = Field(default="", max_length=300)
    mood: str | None = Field(default=None, max_length=60)
    # Số chữ của từng câu: lấy theo số nốt của từng câu nhạc đang có.
    line_syllables: list[int] = Field(min_length=1, max_length=40)
    # Bước cao độ (nửa cung) giữa các nốt liền nhau của từng câu, để AI chọn chữ có thanh hợp hướng giai điệu.
    contours: list[list[int]] | None = Field(default=None, max_length=40)
    # Lời đã có phía trước khi viết tiếp.
    before: str | None = Field(default=None, max_length=4000)


class LyricsLine(BaseModel):
    text: str
    syllables: int
    wanted: int


class LyricsResponse(BaseModel):
    title: str
    lines: list[LyricsLine]


class CommandRequest(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    context: str | None = Field(default=None, max_length=500)


class CommandResponse(BaseModel):
    commands: list[str]
    reply: str


def _run(fn, *args):
    try:
        return fn(*args)
    except ai.AIUnavailable:
        _need_ai()
        raise
    except ai.AIError as e:
        raise HTTPException(status_code=e.status, detail=e.message) from None


def _need_ai():
    if not ai.available():
        raise HTTPException(status_code=503, detail="Máy chủ chưa bật AI (chưa có GEMINI_API_KEY, GROQ_API_KEY hoặc ANTHROPIC_API_KEY).")


@router.get("/status")
def status():
    p = ai.provider()
    return {"available": p is not None, "provider": p}


@router.post("/lyrics", response_model=LyricsResponse)
def lyrics(req: LyricsRequest, owner: str = Depends(owner_id)):
    _need_ai()
    if any(n < 1 or n > 24 for n in req.line_syllables):
        raise HTTPException(status_code=422, detail="Mỗi câu cần từ 1 đến 24 chữ.")
    _run(ai.take_quota, owner)
    out = _run(ai.write_lyrics, req.topic, req.mood, req.line_syllables, req.contours, req.before)
    lines = [LyricsLine(text=t, syllables=ai.count_syllables(t), wanted=req.line_syllables[i]) for i, t in enumerate(out.lines)]
    return LyricsResponse(title=out.title.strip()[:80], lines=lines)


@router.post("/command", response_model=CommandResponse)
def command(req: CommandRequest, owner: str = Depends(owner_id)):
    _need_ai()
    _run(ai.take_quota, owner)
    out = _run(ai.understand_command, req.text, req.context)
    return CommandResponse(commands=out.commands, reply=out.reply.strip()[:300])
