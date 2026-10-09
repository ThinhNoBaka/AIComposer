"""API tab "Giọng hát": tải bản thu giọng lên, chỉnh cao độ, nghe lại bản gốc/bản đã chỉnh."""

import io
import time
from datetime import datetime, timezone
from typing import Literal

import numpy as np
import soundfile as sf
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import MAX_UPLOAD_MB
from ..db import get_session
from ..deps import owner_id
from ..humming.audio import AudioDecodeError, load_audio
from ..humming.keys import SCALES
from ..models import Project, VocalTake
from ..vocal.correct import Analysis, CorrectionParams, correct_vocal

router = APIRouter(prefix="/api/vocal", tags=["vocal"])

VOCAL_SR = 44100
MAX_TAKE_SECONDS = 300  # 5 phút: WAV 44.1 kHz PCM16 ≈ 26 MB mỗi bản


def _utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


def _wav_bytes(y: np.ndarray, sr: int) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, np.clip(y, -1.0, 1.0), sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def _read_wav(data: bytes) -> np.ndarray:
    y, _ = sf.read(io.BytesIO(data), dtype="float32")
    return y


def _get(session: Session, tid: str, owner: str) -> VocalTake:
    t = session.get(VocalTake, tid)
    if not t or t.owner != owner:
        raise HTTPException(status_code=404, detail="Không tìm thấy bản thu.")
    return t


def _summary(t: VocalTake) -> dict:
    return {
        "id": t.id,
        "project_id": t.project_id,
        "created_at": _utc(t.created_at),
        "duration_s": t.duration_s,
        "sr": t.sr,
        "offset_ms": t.offset_ms,
        "bpm": t.bpm,
        "recipe": t.recipe,
        "has_corrected": t.recipe is not None,
    }


@router.post("/takes", status_code=201)
async def upload_take(
    audio: UploadFile = File(...),
    project_id: str | None = Form(default=None),
    offset_ms: float = Form(default=0.0),
    bpm: float | None = Form(default=None),
    owner: str = Depends(owner_id),
    session: Session = Depends(get_session),
):
    data = await audio.read()
    if len(data) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"File quá lớn (tối đa {MAX_UPLOAD_MB:g} MB).")
    if bpm is not None and not 40 <= bpm <= 220:
        raise HTTPException(status_code=422, detail="Tempo phải trong khoảng 40–220.")
    if not np.isfinite(offset_ms) or abs(offset_ms) > 3_600_000:
        raise HTTPException(status_code=422, detail="offset_ms không hợp lệ.")
    if project_id:
        p = session.get(Project, project_id)
        if not p or p.owner != owner:
            raise HTTPException(status_code=404, detail="Không tìm thấy bài.")
    try:
        y = await run_in_threadpool(load_audio, data, VOCAL_SR)
    except AudioDecodeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    duration = len(y) / VOCAL_SR
    if duration < 0.1:
        raise HTTPException(status_code=400, detail="Bản thu quá ngắn.")
    if duration > MAX_TAKE_SECONDS:
        raise HTTPException(status_code=413, detail=f"Bản thu quá dài (tối đa {MAX_TAKE_SECONDS // 60} phút).")

    take = VocalTake(
        owner=owner,
        project_id=project_id or None,
        offset_ms=float(offset_ms),
        bpm=bpm,
        sr=VOCAL_SR,
        duration_s=round(duration, 3),
        original=await run_in_threadpool(_wav_bytes, y, VOCAL_SR),
    )
    session.add(take)
    session.commit()
    return {"id": take.id, "duration_s": take.duration_s, "sr": take.sr, "offset_ms": take.offset_ms, "bpm": take.bpm, "project_id": take.project_id}


@router.get("/takes")
def list_takes(project_id: str | None = None, owner: str = Depends(owner_id), session: Session = Depends(get_session)):
    q = select(VocalTake).where(VocalTake.owner == owner)
    if project_id:
        q = q.where(VocalTake.project_id == project_id)
    rows = session.scalars(q.order_by(VocalTake.created_at.desc()).limit(200))
    return [_summary(t) for t in rows]


class KeyIn(BaseModel):
    tonic: int = Field(ge=0, le=11)
    mode: str


class NoteIn(BaseModel):
    pitch: float = Field(ge=0, le=127)
    start_s: float  # theo thời gian bài hát (giây); server trừ offset_ms của bản thu
    end_s: float


class CorrectIn(BaseModel):
    strength: float = Field(default=1.0, ge=0, le=1)
    mode: Literal["melody", "scale", "chromatic"] = "scale"
    retune_speed_ms: float = Field(default=0.0, ge=0, le=2000)
    keep_vibrato: bool = True
    key: KeyIn | None = None
    notes: list[NoteIn] = Field(default_factory=list, max_length=20000)


def _run_correction(original: bytes, sr: int, analysis: dict | None, params: CorrectionParams) -> tuple[bytes, dict, np.ndarray, np.ndarray]:
    y = _read_wav(original)
    an = Analysis.from_json(analysis) if analysis else None
    out, an, corrected_midi = correct_vocal(y, sr, params, an)
    wav = original if out is y else _wav_bytes(out, sr)  # strength = 0: giữ nguyên từng byte bản gốc
    return wav, an.to_json(), an.midi, corrected_midi


def _curve(m: np.ndarray) -> list[float | None]:
    return [None if not np.isfinite(v) else round(float(v), 2) for v in m]


@router.post("/takes/{tid}/correct")
async def correct_take(tid: str, body: CorrectIn, owner: str = Depends(owner_id), session: Session = Depends(get_session)):
    take = _get(session, tid, owner)
    if body.key is not None and body.key.mode not in SCALES:
        raise HTTPException(status_code=422, detail=f"Giọng không hợp lệ: mode phải là một trong {sorted(SCALES)}.")
    if body.mode == "scale" and body.key is None:
        raise HTTPException(status_code=422, detail="Chế độ 'scale' cần giọng (key).")
    if body.mode == "melody" and not body.notes and body.key is None:
        raise HTTPException(status_code=422, detail="Chế độ 'melody' cần danh sách nốt (notes) hoặc giọng (key).")
    off = take.offset_ms / 1000.0
    params = CorrectionParams(
        strength=body.strength,
        mode=body.mode,
        retune_speed_ms=body.retune_speed_ms,
        keep_vibrato=body.keep_vibrato,
        tonic=body.key.tonic if body.key else None,
        scale=body.key.mode if body.key else None,
        notes=[{"pitch": n.pitch, "start_s": n.start_s - off, "end_s": n.end_s - off} for n in body.notes if n.end_s > n.start_s],
    )
    t0 = time.perf_counter()
    wav, analysis, orig_midi, corr_midi = await run_in_threadpool(_run_correction, take.original, take.sr, take.analysis, params)
    elapsed = int((time.perf_counter() - t0) * 1000)

    recipe = {
        "strength": body.strength,
        "mode": body.mode,
        "retune_speed_ms": body.retune_speed_ms,
        "keep_vibrato": body.keep_vibrato,
        "key": body.key.model_dump() if body.key else None,
        "notes_count": len(params.notes),
    }
    take.corrected = wav
    take.recipe = recipe
    if take.analysis is None:
        take.analysis = analysis
    session.commit()
    return {
        "id": take.id,
        "recipe": recipe,
        "duration_s": take.duration_s,
        "elapsed_ms": elapsed,
        "f0": {"hop_s": analysis["hop_s"], "original": _curve(orig_midi), "corrected": _curve(corr_midi)},
    }


@router.get("/takes/{tid}/audio")
def take_audio(
    tid: str,
    version: Literal["original", "corrected"] = Query(default="original"),
    owner: str = Depends(owner_id),
    session: Session = Depends(get_session),
):
    take = _get(session, tid, owner)
    data = take.original if version == "original" else take.corrected
    if data is None:
        raise HTTPException(status_code=404, detail="Bản thu này chưa được chỉnh cao độ.")
    return Response(content=data, media_type="audio/wav", headers={"Cache-Control": "no-store"})


@router.delete("/takes/{tid}", status_code=204)
def delete_take(tid: str, owner: str = Depends(owner_id), session: Session = Depends(get_session)):
    session.delete(_get(session, tid, owner))
    session.commit()
