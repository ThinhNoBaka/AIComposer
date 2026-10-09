from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_session
from ..deps import owner_id
from ..models import Project

router = APIRouter(prefix="/api/projects", tags=["projects"])


class ProjectIn(BaseModel):
    title: str = Field(default="Bài hát mới", max_length=200)
    song: dict


def _as_utc(dt: datetime) -> datetime:
    # SQLite trả về datetime không có múi giờ (đã lưu theo UTC); gắn lại để trình duyệt đổi đúng giờ địa phương.
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


class ProjectSummary(BaseModel):
    id: str
    title: str
    updated_at: datetime

    _utc = field_validator("updated_at")(_as_utc)


class ProjectOut(ProjectSummary):
    song: dict
    created_at: datetime

    _utc_created = field_validator("created_at")(_as_utc)


def _validate_song(song: dict) -> None:
    if song.get("version") != 1 or not isinstance(song.get("melody"), list) or not isinstance(song.get("chords"), list):
        raise HTTPException(status_code=422, detail="Dữ liệu bài nhạc không hợp lệ.")


def _get(session: Session, pid: str, owner: str) -> Project:
    p = session.get(Project, pid)
    if not p or p.owner != owner:
        raise HTTPException(status_code=404, detail="Không tìm thấy bài.")
    return p


@router.get("", response_model=list[ProjectSummary])
def list_projects(owner: str = Depends(owner_id), session: Session = Depends(get_session)):
    rows = session.scalars(select(Project).where(Project.owner == owner).order_by(Project.updated_at.desc()).limit(200))
    return [ProjectSummary(id=p.id, title=p.title, updated_at=p.updated_at) for p in rows]


@router.post("", response_model=ProjectOut, status_code=201)
def create_project(body: ProjectIn, owner: str = Depends(owner_id), session: Session = Depends(get_session)):
    _validate_song(body.song)
    p = Project(owner=owner, title=body.title, song=body.song)
    session.add(p)
    session.commit()
    return p


@router.get("/{pid}", response_model=ProjectOut)
def get_project(pid: str, owner: str = Depends(owner_id), session: Session = Depends(get_session)):
    return _get(session, pid, owner)


@router.put("/{pid}", response_model=ProjectOut)
def update_project(pid: str, body: ProjectIn, owner: str = Depends(owner_id), session: Session = Depends(get_session)):
    _validate_song(body.song)
    p = _get(session, pid, owner)
    p.title = body.title
    p.song = body.song
    session.commit()
    return p


@router.delete("/{pid}", status_code=204)
def delete_project(pid: str, owner: str = Depends(owner_id), session: Session = Depends(get_session)):
    session.delete(_get(session, pid, owner))
    session.commit()
