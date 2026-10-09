import time

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import MAX_UPLOAD_MB
from ..db import get_session
from ..deps import owner_id
from ..humming.audio import AudioDecodeError
from ..humming.pipeline import TranscribeOptions, transcribe_bytes
from ..models import Project, Recording, Transcription

router = APIRouter(prefix="/api/humming", tags=["humming"])

MODES = {"major", "minor", "dorian", "majorPentatonic", "minorPentatonic"}


@router.post("")
async def transcribe(
    audio: UploadFile = File(...),
    bpm: float | None = Form(default=None),
    tonic: int | None = Form(default=None),
    mode: str | None = Form(default=None),
    snap: bool = Form(default=True),
    project_id: str | None = Form(default=None),
    owner: str = Depends(owner_id),
    session: Session = Depends(get_session),
):
    data = await audio.read()
    if len(data) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"File quá lớn (tối đa {MAX_UPLOAD_MB:g} MB).")
    if bpm is not None and not 40 <= bpm <= 220:
        raise HTTPException(status_code=422, detail="Tempo phải trong khoảng 40–220.")
    if (tonic is None) != (mode is None) or (tonic is not None and not 0 <= tonic <= 11) or (mode is not None and mode not in MODES):
        raise HTTPException(status_code=422, detail="Giọng không hợp lệ: cần cả tonic (0–11) và mode, hoặc bỏ trống cả hai.")
    if project_id:
        p = session.get(Project, project_id)
        if not p or p.owner != owner:
            raise HTTPException(status_code=404, detail="Không tìm thấy bài.")

    opts = TranscribeOptions(bpm=bpm, tonic=tonic, mode=mode, snap=snap)
    t0 = time.perf_counter()
    try:
        result = await run_in_threadpool(transcribe_bytes, data, opts)
    except AudioDecodeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    elapsed = int((time.perf_counter() - t0) * 1000)

    rec = Recording(
        owner=owner,
        project_id=project_id,
        filename=(audio.filename or "humming")[:255],
        content_type=(audio.content_type or "application/octet-stream")[:100],
        size_bytes=len(data),
        duration_sec=result["duration_sec"],
        audio=data,
    )
    session.add(rec)
    session.flush()
    tr = Transcription(recording_id=rec.id, result=result, elapsed_ms=elapsed)
    session.add(tr)
    session.commit()
    return {"recording_id": rec.id, "transcription_id": tr.id, "elapsed_ms": elapsed, **result}


@router.get("/recordings")
def list_recordings(owner: str = Depends(owner_id), session: Session = Depends(get_session)):
    rows = session.scalars(select(Recording).where(Recording.owner == owner).order_by(Recording.created_at.desc()).limit(100))
    return [
        {"id": r.id, "filename": r.filename, "duration_sec": r.duration_sec, "size_bytes": r.size_bytes, "project_id": r.project_id, "created_at": r.created_at}
        for r in rows
    ]
