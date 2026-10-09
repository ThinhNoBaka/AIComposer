import logging
import threading
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from .config import CORS_ORIGINS, STATIC_DIR, WARMUP
from .db import engine, init_db
from .routes import ai, humming, projects, vocal


log = logging.getLogger("uvicorn.error")


def _warmup():
    # Lần nhận nốt đầu tiên phải biên dịch numba (vài giây); chạy trước một bản ngân giả để người dùng đầu tiên không phải chờ.
    from .humming.pipeline import transcribe_array
    from .humming.synth import synth_hum

    t = time.perf_counter()
    try:
        transcribe_array(synth_hum([(0.1, 0.5, 60), (0.6, 1.0, 64)], 16000), 16000)
        log.info("humming warm-up xong sau %.1fs", time.perf_counter() - t)
    except Exception:  # noqa: BLE001
        log.exception("humming warm-up lỗi")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    if WARMUP:
        threading.Thread(target=_warmup, daemon=True).start()
    yield


app = FastAPI(title="AIComposer API", version="0.1.0", lifespan=lifespan)

if CORS_ORIGINS:
    app.add_middleware(CORSMiddleware, allow_origins=CORS_ORIGINS, allow_methods=["*"], allow_headers=["*"])

app.include_router(projects.router)
app.include_router(humming.router)
app.include_router(vocal.router)
app.include_router(ai.router)


@app.get("/api/health")
def health():
    with engine.connect() as c:
        c.execute(text("select 1"))
    return {"ok": True, "database": engine.dialect.name}


# Phục vụ giao diện web đã build (frontend/dist) từ cùng một server.
if STATIC_DIR.exists():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        if path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Không có API này.")
        f = STATIC_DIR / path
        if path and f.is_file() and STATIC_DIR in f.resolve().parents:
            return FileResponse(f)
        return FileResponse(STATIC_DIR / "index.html")
