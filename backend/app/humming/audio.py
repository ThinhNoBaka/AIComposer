"""Đọc audio từ bytes (WAV, MP3, OGG, WebM...) thành mảng float32 mono."""

from __future__ import annotations

import io
import os
import shutil
import subprocess
import tempfile

import numpy as np
import soundfile as sf

TARGET_SR = 16000


class AudioDecodeError(ValueError):
    pass


def ffmpeg_exe() -> str | None:
    """ffmpeg của hệ thống nếu có, không thì bản dựng sẵn đi kèm gói imageio-ffmpeg (chạy được cả Windows/macOS)."""
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001 - không có gói hoặc không có bản cho nền tảng này
        return None


def load_audio(data: bytes, sr: int = TARGET_SR) -> np.ndarray:
    """Giải mã audio về mono float32 ở tần số lấy mẫu `sr`.

    Ưu tiên ffmpeg (đọc được WebM/Opus mà trình duyệt ghi âm ra); không có ffmpeg thì dùng soundfile.
    """
    if not data:
        raise AudioDecodeError("File audio rỗng.")
    exe = ffmpeg_exe()
    if exe:
        proc = subprocess.run(
            [exe, "-v", "error", "-i", "pipe:0", "-ac", "1", "-ar", str(sr), "-f", "f32le", "pipe:1"],
            input=data,
            capture_output=True,
            timeout=120,
        )
        if proc.returncode != 0 or not proc.stdout:
            raise AudioDecodeError("Không giải mã được file audio: " + proc.stderr.decode(errors="ignore")[-200:])
        return np.frombuffer(proc.stdout, dtype=np.float32).copy()
    try:
        y, file_sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
    except Exception as exc:  # noqa: BLE001 - mọi lỗi định dạng đều báo chung một kiểu
        raise AudioDecodeError(f"Không đọc được file audio: {exc}") from exc
    y = y.mean(axis=1)
    if file_sr != sr:
        import librosa

        y = librosa.resample(y, orig_sr=file_sr, target_sr=sr)
    return y.astype(np.float32)


def load_audio_file(path: str, sr: int = TARGET_SR) -> np.ndarray:
    """Như load_audio nhưng đọc từ file trên đĩa và ghi kết quả ra file tạm: bản thu dài không phải giữ hai bản trong RAM."""
    exe = ffmpeg_exe()
    if not exe:
        with open(path, "rb") as f:
            return load_audio(f.read(), sr)
    fd, out = tempfile.mkstemp(suffix=".f32")
    os.close(fd)
    try:
        proc = subprocess.run(
            [exe, "-v", "error", "-y", "-i", path, "-ac", "1", "-ar", str(sr), "-f", "f32le", out],
            capture_output=True,
            timeout=900,
        )
        if proc.returncode != 0:
            raise AudioDecodeError("Không giải mã được file audio: " + proc.stderr.decode(errors="ignore")[-200:])
        y = np.fromfile(out, dtype=np.float32)
    finally:
        os.unlink(out)
    if not len(y):
        raise AudioDecodeError("File audio rỗng.")
    return y


def compress_for_storage(path: str) -> bytes | None:
    """Nén bản thu thành Opus mono 24 kbps (20 phút khoảng 4 MB) để lưu vào database. Không nén được thì None."""
    exe = ffmpeg_exe()
    if not exe:
        return None
    proc = subprocess.run(
        [exe, "-v", "error", "-i", path, "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "24k", "-f", "ogg", "pipe:1"],
        capture_output=True,
        timeout=900,
    )
    return proc.stdout if proc.returncode == 0 and proc.stdout else None
