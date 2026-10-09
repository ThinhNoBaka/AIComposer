# Một image chạy cả giao diện web lẫn API: build frontend bằng Node, rồi phục vụ bằng FastAPI.

FROM node:22-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    NUMBA_CACHE_DIR=/tmp/numba \
    STATIC_DIR=/app/static \
    PORT=8000
WORKDIR /app
# ffmpeg (đọc WebM/Opus từ trình duyệt) đi kèm gói imageio-ffmpeg, libsndfile đi kèm soundfile: không cần apt.
COPY backend/requirements.txt .
RUN pip install -r requirements.txt
COPY backend/app ./app
# Mô hình học máy (vd. humming_onset.json). Thư mục có thể chỉ có README: thiếu file thì app dùng cách tách nốt cũ.
COPY backend/models ./models
ENV HUMMING_MODEL=/app/models/humming_onset.json
# Bộ cấp phát bộ nhớ trả RAM lại cho hệ thống sau mỗi bản ngân dài (máy chủ miễn phí chỉ 512 MB):
# bản 15 phút xử lý hai lần liền đo được 420 MB thay vì 482 MB.
ENV MALLOC_ARENA_MAX=2 \
    MALLOC_TRIM_THRESHOLD_=1048576 \
    MALLOC_MMAP_THRESHOLD_=1048576
COPY --from=web /web/dist ./static
# Không đặt DATABASE_URL thì dùng SQLite trong /app/data (thư mục user app ghi được). Deploy thật thì đặt DATABASE_URL tới PostgreSQL.
ENV DATABASE_URL=sqlite:////app/data/aicomposer.db
RUN useradd --create-home --uid 1000 app && mkdir -p /app/data && chown app /app/data
USER app
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD python -c "import os,urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"8000\")}/api/health', timeout=4)"
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
