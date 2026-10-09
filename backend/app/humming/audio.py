"""Đọc audio từ bytes (WAV, MP3, OGG, WebM...) thành mảng float32 mono."""

from __future__ import annotations

import io
import shutil
import subprocess

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
