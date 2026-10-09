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
    vocal_takes: Mapped[list["VocalTake"]] = relationship(back_populates="project", cascade="all, delete-orphan")
    revisions: Mapped[list["ProjectRevision"]] = relationship(back_populates="project", cascade="all, delete-orphan")


class ProjectRevision(Base):
    """Bản chụp bài trước mỗi lần lưu đè (lịch sử phiên bản). Giữ tối đa MAX_REVISIONS bản mới nhất mỗi bài."""

    __tablename__ = "project_revisions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(200))
    song: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    project: Mapped[Project] = relationship(back_populates="revisions")


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


class VocalTake(Base):
    """Một lần thu giọng hát (tab "Giọng hát"): bản gốc, bản đã chỉnh cao độ và công thức chỉnh.

    Audio lưu dạng WAV PCM16 mono đã giải mã lại (không giữ file trình duyệt gửi lên). Cột bytes để `deferred`
    để liệt kê danh sách không phải đọc audio.
    """

    __tablename__ = "vocal_takes"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    owner: Mapped[str] = mapped_column(String(64), index=True)
    project_id: Mapped[str | None] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    offset_ms: Mapped[float] = mapped_column(Float, default=0)  # bản thu bắt đầu ở mốc này của bài (ms)
    bpm: Mapped[float | None] = mapped_column(Float, nullable=True)
    sr: Mapped[int] = mapped_column(Integer)
    duration_s: Mapped[float] = mapped_column(Float, default=0)
    original: Mapped[bytes] = mapped_column(LargeBinary, deferred=True)
    corrected: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True, deferred=True)
    recipe: Mapped[dict | None] = mapped_column(JSON, nullable=True)  # strength, mode, retune_speed_ms, keep_vibrato, key
    analysis: Mapped[dict | None] = mapped_column(JSON, nullable=True, deferred=True)  # F0 pYIN đã dò, để chỉnh lại khỏi dò lần nữa
    project: Mapped[Project | None] = relationship(back_populates="vocal_takes")
