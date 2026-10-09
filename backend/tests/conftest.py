import os
import tempfile

# DB riêng cho test, phải đặt trước khi import app.
_tmp = tempfile.mkdtemp()
os.environ.setdefault("DATABASE_URL", f"sqlite:///{_tmp}/test.db")
os.environ.setdefault("WARMUP", "0")
