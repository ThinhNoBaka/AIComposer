"""Kiểm tra máy có chạy được AIComposer chưa, và chỉ cách sửa từng lỗi.

Chạy từ thư mục backend:  python -m scripts.doctor   (thêm --port 8000 nếu dùng cổng khác)
"""

from __future__ import annotations

import argparse
import importlib
import os
import shutil
import socket
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
OK, WARN, FAIL = "OK  ", "CHÚ Ý", "LỖI "
results: list[tuple[str, str, str, str]] = []


def report(status: str, name: str, detail: str, fix: str = "") -> None:
    results.append((status, name, detail, fix))


def check_python() -> None:
    v = sys.version_info
    if v >= (3, 11):
        report(OK, "Python", f"{v.major}.{v.minor}.{v.micro}")
    else:
        report(FAIL, "Python", f"{v.major}.{v.minor}", "Cần Python 3.11 trở lên (khuyên dùng 3.13 như Docker/CI).")


def check_packages() -> None:
    req = BACKEND / "requirements.txt"
    names = {
        "fastapi": "fastapi",
        "uvicorn": "uvicorn",
        "python-multipart": "multipart",
        "pydantic": "pydantic",
        "SQLAlchemy": "sqlalchemy",
        "psycopg": "psycopg",
        "numpy": "numpy",
        "scipy": "scipy",
        "numba": "numba",
        "librosa": "librosa",
        "soundfile": "soundfile",
        "mir_eval": "mir_eval",
        "imageio-ffmpeg": "imageio_ffmpeg",
    }
    missing = []
    for pkg, mod in names.items():
        try:
            importlib.import_module(mod)
        except Exception:  # noqa: BLE001 - lỗi import nào cũng tính là thiếu
            missing.append(pkg)
    if missing:
        report(FAIL, "Thư viện Python", "thiếu " + ", ".join(missing), f"Chạy: pip install -r {req.relative_to(ROOT)}")
    else:
        report(OK, "Thư viện Python", "đủ theo requirements.txt")


def check_ffmpeg() -> None:
    sys.path.insert(0, str(BACKEND))
    try:
        from app.humming.audio import ffmpeg_exe

        exe = ffmpeg_exe()
    except Exception as exc:  # noqa: BLE001
        report(FAIL, "ffmpeg", f"không gọi được: {exc}", "Cài gói imageio-ffmpeg (có sẵn trong requirements.txt).")
        return
    if not exe:
        report(FAIL, "ffmpeg", "không tìm thấy", "pip install imageio-ffmpeg, hoặc cài ffmpeg hệ thống. Thiếu ffmpeg thì không đọc được file ghi âm WebM từ trình duyệt.")
        return
    try:
        out = subprocess.run([exe, "-version"], capture_output=True, text=True, timeout=10).stdout.splitlines()[0]
        report(OK, "ffmpeg", out[:60])
    except Exception as exc:  # noqa: BLE001
        report(FAIL, "ffmpeg", f"{exe} không chạy được: {exc}", "Cài lại imageio-ffmpeg hoặc ffmpeg hệ thống.")


def check_database() -> None:
    sys.path.insert(0, str(BACKEND))
    try:
        from sqlalchemy import create_engine, text

        from app.config import DATABASE_URL
    except Exception as exc:  # noqa: BLE001
        report(FAIL, "Database", f"không nạp được cấu hình: {exc}", "Cài thư viện Python trước.")
        return
    shown = DATABASE_URL.split("@")[-1] if "@" in DATABASE_URL else DATABASE_URL
    try:
        engine = create_engine(DATABASE_URL)
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        report(OK, "Database", shown)
    except Exception as exc:  # noqa: BLE001
        msg = str(exc).splitlines()[0][:120]
        fix = (
            "Kiểm tra DATABASE_URL (Postgres đã chạy chưa? docker compose up -d db). Bỏ trống DATABASE_URL thì app dùng SQLite tại chỗ."
            if "sqlite" not in DATABASE_URL
            else "Thư mục chứa file SQLite phải ghi được."
        )
        report(FAIL, "Database", f"{shown}: {msg}", fix)


def check_models() -> None:
    hum = Path(os.environ.get("HUMMING_MODEL", BACKEND / "models" / "humming_onset.json"))
    if hum.is_file():
        report(OK, "Model humming", str(hum))
    else:
        report(WARN, "Model humming", "chưa có file, đang dùng cách tách nốt mặc định", "Không bắt buộc. Train bằng ml/humming (xem README) rồi đặt file vào backend/models/.")
    tone = ROOT / "frontend" / "public" / "models" / "tone_model.json"
    if tone.is_file():
        report(OK, "Model thanh điệu", str(tone.relative_to(ROOT)))
    else:
        report(WARN, "Model thanh điệu", "chưa có file, đang dùng luật thanh điệu", "Không bắt buộc. Train bằng ml/vn_tone rồi đặt tone_model.json vào frontend/public/models/.")
    harmony = ROOT / "frontend" / "src" / "core" / "harmonyModel.json"
    report(OK if harmony.is_file() else WARN, "Model hoà âm", "có (POP909)" if harmony.is_file() else "thiếu, dùng luật", "" if harmony.is_file() else "Chạy ml/harmony/train.py.")


def check_frontend() -> None:
    dist = ROOT / "frontend" / "dist" / "index.html"
    node = shutil.which("node")
    if node:
        v = subprocess.run([node, "--version"], capture_output=True, text=True).stdout.strip()
        major = int(v.lstrip("v").split(".")[0] or 0)
        report(OK if major >= 20 else WARN, "Node.js", v, "" if major >= 20 else "Nên dùng Node 22 như Docker/CI.")
    else:
        report(WARN, "Node.js", "không có", "Cần Node 22 để build giao diện (cd frontend && npm ci && npm run build). Không cần nếu chỉ chạy Docker.")
    if dist.is_file():
        report(OK, "Giao diện đã build", str(dist.parent.relative_to(ROOT)))
    else:
        report(WARN, "Giao diện đã build", "chưa có frontend/dist", "cd frontend && npm ci && npm run build (hoặc chạy npm run dev riêng ở cổng 5173).")


def check_port(port: int) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        busy = s.connect_ex(("127.0.0.1", port)) == 0
    if busy:
        report(WARN, f"Cổng {port}", "đang có chương trình khác dùng (có thể là backend đã chạy)", "Tắt chương trình đó hoặc chạy uvicorn với --port khác.")
    else:
        report(OK, f"Cổng {port}", "còn trống")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    args = ap.parse_args()
    check_python()
    check_packages()
    check_ffmpeg()
    check_database()
    check_models()
    check_frontend()
    check_port(args.port)
    width = max(len(r[1]) for r in results)
    for status, name, detail, fix in results:
        print(f"[{status}] {name.ljust(width)}  {detail}")
        if fix and status != OK:
            print(f"        {' ' * width}  -> {fix}")
    fails = sum(r[0] == FAIL for r in results)
    print()
    print("Mọi thứ sẵn sàng." if not fails else f"Có {fails} lỗi cần sửa trước khi chạy.")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
