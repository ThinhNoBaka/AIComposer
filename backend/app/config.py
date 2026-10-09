import os
from pathlib import Path


def _db_url() -> str:
    url = os.environ.get("DATABASE_URL", "sqlite:///./aicomposer.db")
    # Render/Heroku cấp dạng postgres://; SQLAlchemy + psycopg 3 cần postgresql+psycopg://
    if url.startswith("postgres://"):
        url = "postgresql+psycopg://" + url[len("postgres://") :]
    elif url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://") :]
    return url


DATABASE_URL = _db_url()
MAX_UPLOAD_MB = float(os.environ.get("MAX_UPLOAD_MB", "15"))
# Ngân nga: file lưu tạm ra đĩa nên cho tải lớn được. Thời lượng bị giới hạn bởi RAM máy chủ (Render miễn phí 512 MB):
# 15 phút dùng khoảng 400 MB lúc xử lý. Máy chủ mạnh hơn thì tăng HUM_MAX_MINUTES.
HUM_MAX_UPLOAD_MB = float(os.environ.get("HUM_MAX_UPLOAD_MB", "200"))
HUM_MAX_MINUTES = float(os.environ.get("HUM_MAX_MINUTES", "15"))
STATIC_DIR = Path(os.environ.get("STATIC_DIR", Path(__file__).resolve().parents[2] / "frontend" / "dist"))
CORS_ORIGINS = [o for o in os.environ.get("CORS_ORIGINS", "").split(",") if o]
WARMUP = os.environ.get("WARMUP", "1") != "0"
