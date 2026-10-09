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
STATIC_DIR = Path(os.environ.get("STATIC_DIR", Path(__file__).resolve().parents[2] / "frontend" / "dist"))
CORS_ORIGINS = [o for o in os.environ.get("CORS_ORIGINS", "").split(",") if o]
WARMUP = os.environ.get("WARMUP", "1") != "0"
