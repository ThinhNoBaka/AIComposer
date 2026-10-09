from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_session
from ..deps import owner_id
from ..models import Project, ProjectRevision

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


MAX_REVISIONS = 50


class RevisionSummary(BaseModel):
    id: str
    title: str
    created_at: datetime
    notes: int
    bars: int

    _utc = field_validator("created_at")(_as_utc)


def _snapshot(session: Session, p: Project) -> None:
    """Lưu bản hiện tại của bài thành một phiên bản, rồi bỏ các phiên bản cũ quá giới hạn."""
    session.add(ProjectRevision(project_id=p.id, title=p.title, song=p.song))
    session.flush()
    old = session.scalars(
        select(ProjectRevision)
        .where(ProjectRevision.project_id == p.id)
        .order_by(ProjectRevision.created_at.desc(), ProjectRevision.id)
        .offset(MAX_REVISIONS)
    ).all()
    for r in old:
        session.delete(r)


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
    if p.song != body.song or p.title != body.title:
        _snapshot(session, p)
    p.title = body.title
    p.song = body.song
    session.commit()
    return p


@router.get("/{pid}/revisions", response_model=list[RevisionSummary])
def list_revisions(pid: str, owner: str = Depends(owner_id), session: Session = Depends(get_session)):
    """Các phiên bản đã lưu trước đây, mới nhất trước."""
    p = _get(session, pid, owner)
    rows = session.scalars(
        select(ProjectRevision).where(ProjectRevision.project_id == p.id).order_by(ProjectRevision.created_at.desc(), ProjectRevision.id)
    )
    return [
        RevisionSummary(
            id=r.id,
            title=r.title,
            created_at=r.created_at,
            notes=len(r.song.get("melody") or []),
            bars=int(r.song.get("bars") or 0),
        )
        for r in rows
    ]


@router.post("/{pid}/revisions/{rid}/restore", response_model=ProjectOut)
def restore_revision(pid: str, rid: str, owner: str = Depends(owner_id), session: Session = Depends(get_session)):
    """Quay về một phiên bản cũ. Bản đang có được lưu thành phiên bản mới nên khôi phục nhầm vẫn quay lại được."""
    p = _get(session, pid, owner)
    r = session.get(ProjectRevision, rid)
    if not r or r.project_id != p.id:
        raise HTTPException(status_code=404, detail="Không tìm thấy phiên bản.")
    song, title = r.song, r.title
    _snapshot(session, p)
    p.title = title
    p.song = song
    session.commit()
    return p


@router.delete("/{pid}", status_code=204)
def delete_project(pid: str, owner: str = Depends(owner_id), session: Session = Depends(get_session)):
    session.delete(_get(session, pid, owner))
    session.commit()
