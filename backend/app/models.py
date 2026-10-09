import uuid
from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, Float, ForeignKey, Integer, LargeBinary, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _uuid() -> str:
    return str(uuid.uuid4())


class Project(Base):
    """Một bài nhạc. `song` là JSON đúng định dạng Song của web."""

    __tablename__ = "projects"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    owner: Mapped[str] = mapped_column(String(64), index=True)
    title: Mapped[str] = mapped_column(String(200), default="Bài hát mới")
    song: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)
    recordings: Mapped[list["Recording"]] = relationship(back_populates="project", cascade="all, delete-orphan")


class Recording(Base):
    """Bản thu ngân nga gốc. Lưu bytes trong DB cho đơn giản (giới hạn dung lượng ở API)."""

    __tablename__ = "recordings"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    owner: Mapped[str] = mapped_column(String(64), index=True)
    project_id: Mapped[str | None] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), nullable=True, index=True)
    filename: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(100))
    size_bytes: Mapped[int] = mapped_column(Integer)
    duration_sec: Mapped[float] = mapped_column(Float, default=0)
    audio: Mapped[bytes] = mapped_column(LargeBinary)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    project: Mapped[Project | None] = relationship(back_populates="recordings")
    transcriptions: Mapped[list["Transcription"]] = relationship(back_populates="recording", cascade="all, delete-orphan")


class Transcription(Base):
    """Kết quả nhận nốt cho một bản thu, kèm tham số, để so sánh và đánh giá về sau."""

    __tablename__ = "transcriptions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    recording_id: Mapped[str] = mapped_column(ForeignKey("recordings.id", ondelete="CASCADE"), index=True)
    method: Mapped[str] = mapped_column(String(50), default="pyin-v1")
    result: Mapped[dict] = mapped_column(JSON)
    elapsed_ms: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    recording: Mapped[Recording] = relationship(back_populates="transcriptions")
