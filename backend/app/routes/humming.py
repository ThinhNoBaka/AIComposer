"""Nhận nốt từ bản ngân nga.

Bản thu dài (tới HUM_MAX_MINUTES phút) mất nhiều thời gian trên máy chủ yếu, nên giao diện dùng chế độ chạy nền:
POST /api/humming/jobs trả mã việc ngay, rồi hỏi GET /api/humming/jobs/{id} để lấy tiến độ và kết quả.
Mỗi lúc chỉ xử lý một bản (RAM máy chủ miễn phí chỉ đủ cho một bản dài), bản khác xếp hàng.
POST /api/humming (chờ xử lý xong mới trả) vẫn giữ cho script và test.
"""

import os
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import HUM_MAX_MINUTES, HUM_MAX_UPLOAD_MB
from ..db import SessionLocal, get_session
from ..deps import owner_id
from ..humming.audio import AudioDecodeError, compress_for_storage
from ..humming.pipeline import TranscribeOptions, transcribe_file
from ..models import Project, Recording, Transcription

router = APIRouter(prefix="/api/humming", tags=["humming"])

MODES = {"major", "minor", "dorian", "majorPentatonic", "minorPentatonic"}
# Không nén được (thiếu bộ mã Opus) thì chỉ lưu file gốc khi nhỏ hơn mức này, để database miễn phí không đầy.
RAW_STORE_LIMIT = 15 * 1024 * 1024
JOB_KEEP_SEC = 3600


@dataclass
class Upload:
    path: str
    filename: str
    content_type: str
    size: int


@dataclass
class Job:
    id: str
    owner: str
    status: str = "queued"  # queued, running, done, error
    progress: float = 0.0
    result: dict | None = None
    error: str | None = None
    created: float = field(default_factory=time.time)


_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="humming")
_jobs: dict[str, Job] = {}
_jobs_lock = threading.Lock()


@router.get("/limits")
def limits():
    return {"max_minutes": HUM_MAX_MINUTES, "max_upload_mb": HUM_MAX_UPLOAD_MB}


async def _save_upload(audio: UploadFile) -> Upload:
    """Chép file tải lên ra đĩa từng khúc 1 MB, quá giới hạn thì dừng ngay: không giữ cả file trong RAM."""
    limit = HUM_MAX_UPLOAD_MB * 1024 * 1024
    fd, path = tempfile.mkstemp(prefix="hum-", suffix=Path(audio.filename or "").suffix[:10])
    size = 0
    try:
        with os.fdopen(fd, "wb") as f:
            while chunk := await audio.read(1 << 20):
                size += len(chunk)
                if size > limit:
                    raise HTTPException(status_code=413, detail=f"File quá lớn (tối đa {HUM_MAX_UPLOAD_MB:g} MB).")
                f.write(chunk)
    except BaseException:
        os.unlink(path)
        raise
    if size == 0:
        os.unlink(path)
        raise HTTPException(status_code=400, detail="File audio rỗng.")
    return Upload(path, (audio.filename or "humming")[:255], (audio.content_type or "application/octet-stream")[:100], size)


def _check(bpm: float | None, tonic: int | None, mode: str | None, project_id: str | None, owner: str, session: Session) -> None:
    if bpm is not None and not 40 <= bpm <= 220:
        raise HTTPException(status_code=422, detail="Tempo phải trong khoảng 40–220.")
    if (tonic is None) != (mode is None) or (tonic is not None and not 0 <= tonic <= 11) or (mode is not None and mode not in MODES):
        raise HTTPException(status_code=422, detail="Giọng không hợp lệ: cần cả tonic (0–11) và mode, hoặc bỏ trống cả hai.")
    if project_id:
        p = session.get(Project, project_id)
        if not p or p.owner != owner:
            raise HTTPException(status_code=404, detail="Không tìm thấy bài.")


def _process(up: Upload, opts: TranscribeOptions, owner: str, project_id: str | None, progress=None) -> dict:
    """Nhận nốt rồi lưu bản thu (đã nén) và kết quả. Luôn xoá file tạm."""
    try:
        t0 = time.perf_counter()
        result = transcribe_file(up.path, opts, progress=progress)
        elapsed = int((time.perf_counter() - t0) * 1000)
        stored = compress_for_storage(up.path)
        content_type = "audio/ogg" if stored is not None else up.content_type
        if stored is None:
            stored = Path(up.path).read_bytes() if up.size <= RAW_STORE_LIMIT else b""
    finally:
        os.unlink(up.path)
    with SessionLocal() as session:
        rec = Recording(
            owner=owner,
            project_id=project_id,
            filename=up.filename,
            content_type=content_type,
            size_bytes=up.size,
            duration_sec=result["duration_sec"],
            audio=stored,
        )
        session.add(rec)
        session.flush()
        tr = Transcription(recording_id=rec.id, result=result, elapsed_ms=elapsed)
        session.add(tr)
        session.commit()
        return {"recording_id": rec.id, "transcription_id": tr.id, "elapsed_ms": elapsed, **result}


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
    _check(bpm, tonic, mode, project_id, owner, session)
    up = await _save_upload(audio)
    try:
        return await run_in_threadpool(_process, up, TranscribeOptions(bpm=bpm, tonic=tonic, mode=mode, snap=snap), owner, project_id)
    except AudioDecodeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _run_job(job: Job, up: Upload, opts: TranscribeOptions, project_id: str | None) -> None:
    job.status = "running"

    def progress(f: float) -> None:
        job.progress = round(min(0.99, f), 3)

    try:
        job.result = _process(up, opts, job.owner, project_id, progress)
        job.progress = 1.0
        job.status = "done"
    except AudioDecodeError as exc:
        job.error, job.status = str(exc), "error"
    except Exception:  # noqa: BLE001 - báo lỗi chung cho người dùng, chi tiết ở log
        import logging

        logging.getLogger("uvicorn.error").exception("humming job %s lỗi", job.id)
        job.error, job.status = "Máy chủ gặp lỗi khi nhận nốt. Thử lại, hoặc cắt bản thu ngắn hơn.", "error"


def _forget_old() -> None:
    cutoff = time.time() - JOB_KEEP_SEC
    with _jobs_lock:
        for k in [k for k, j in _jobs.items() if j.created < cutoff and j.status in ("done", "error")]:
            del _jobs[k]


@router.post("/jobs")
async def start_job(
    audio: UploadFile = File(...),
    bpm: float | None = Form(default=None),
    tonic: int | None = Form(default=None),
    mode: str | None = Form(default=None),
    snap: bool = Form(default=True),
    project_id: str | None = Form(default=None),
    owner: str = Depends(owner_id),
    session: Session = Depends(get_session),
):
    _check(bpm, tonic, mode, project_id, owner, session)
    up = await _save_upload(audio)
    _forget_old()
    job = Job(id=uuid.uuid4().hex, owner=owner)
    with _jobs_lock:
        _jobs[job.id] = job
    _executor.submit(_run_job, job, up, TranscribeOptions(bpm=bpm, tonic=tonic, mode=mode, snap=snap), project_id)
    return _job_view(job)


def _job_view(job: Job) -> dict:
    out: dict = {"job_id": job.id, "status": job.status, "progress": job.progress}
    if job.status == "queued":
        with _jobs_lock:  # số bản đang chờ hoặc đang chạy trước bản này
            out["ahead"] = sum(1 for j in _jobs.values() if j.status == "running" or (j.status == "queued" and j.created < job.created))
    if job.result is not None:
        out["result"] = job.result
    if job.error:
        out["error"] = job.error
    return out


@router.get("/jobs/{job_id}")
def get_job(job_id: str, owner: str = Depends(owner_id)):
    job = _jobs.get(job_id)
    if not job or job.owner != owner:
        raise HTTPException(status_code=404, detail="Không tìm thấy việc nhận nốt (máy chủ có thể vừa khởi động lại). Gửi lại bản thu nhé.")
    return _job_view(job)


@router.get("/recordings")
def list_recordings(owner: str = Depends(owner_id), session: Session = Depends(get_session)):
    rows = session.scalars(select(Recording).where(Recording.owner == owner).order_by(Recording.created_at.desc()).limit(100))
    return [
        {"id": r.id, "filename": r.filename, "duration_sec": r.duration_sec, "size_bytes": r.size_bytes, "project_id": r.project_id, "created_at": r.created_at}
        for r in rows
    ]
