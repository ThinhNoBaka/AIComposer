# AIComposer

Web app giúp người không biết nhạc lý vẫn sáng tác được: **ngân nga một câu nhạc → máy nhận ra nốt, giọng, nhịp → tự phối hợp âm, bass, trống thành một bài hoàn chỉnh**, rồi chỉnh tiếp trên piano roll đã khoá thang âm (không thể bấm sai nốt).

## Tính năng

- **Ngân nga thành giai điệu** (phần Data Science chính): thu bằng micro hoặc tải file lên, có đếm nhịp trước khi thu. Máy trả về nốt, giọng, tempo, độ tin cậy và hình các nốt thô nó nghe được. Tự bù khi người ngân lệch chuẩn cao độ hoặc tụt dần.
- **Ngân từng đoạn rồi ghép**: mỗi lần ngân có thể ghép nối tiếp vào sau đoạn trước. Máy tự dịch về đúng giọng của bài nếu bạn ngân lệch.
- **Hoàn thiện thành bài**: máy thêm dạo đầu, điệp khúc (đệm dày hơn, có riser dẫn vào) và kết về chủ âm. Muốn dài hơn thì bấm thêm lượt đoạn chính + điệp khúc, bao nhiêu lần cũng được.
- **Timeline kéo dài tự do** kiểu phần mềm làm nhạc: thước ô nhịp (bấm để chọn chỗ phát), cấu trúc bài, hợp âm, piano roll và làn hiệu ứng chung một thanh cuộn. Phía sau bài luôn có vài ô trống: đặt nốt hay hiệu ứng vào đó là bài tự dài ra, không cần chọn trước độ dài (tối đa 256 ô nhịp, hơn 8 phút ở 120 BPM).
- **Hỗ trợ viết lời tiếng Việt**: gõ lời theo từng câu, chữ hiện ngay trên từng nốt. Máy đếm chữ so với số nốt của mỗi câu nhạc, cảnh báo chỗ giai điệu đi ngược thanh điệu (ví dụ chữ "về" hát lên cao dễ nghe thành "vê") và sửa bằng một nút, tìm vần chữ cuối câu, gợi ý chữ cùng vần, chẻ nốt cho đủ chữ, và **viết giai điệu theo lời** (cao độ đi theo thanh sắc, huyền, nặng…). Lời được xuất kèm trong file MIDI và ra file .txt.
- **8 cảm xúc** (Vui tươi, Buồn, Chill, Hùng tráng, Lãng mạn, Sôi động, Mơ màng, Dân gian): mỗi cảm xúc chọn sẵn giọng, tempo, vòng hợp âm, nhạc cụ, kiểu đệm và trống.
- **Hợp âm có màu theo cảm giác** (Ổn định / Chuyển động / Căng): khi đổi, gợi ý hợp âm hợp với giai điệu. Nút "Hợp âm theo giai điệu" dùng mô hình HMM học từ 909 bài POP909 (giải mã Viterbi), không có mô hình thì dùng luật.
- **Tạo giai điệu tự động**: 3 phương án, Viết tiếp, Biến tấu, Cao hơn/Thấp hơn.
- **128 nhạc cụ General MIDI, 5 bộ trống và 22 hiệu ứng âm thanh** (mưa, gió, sóng biển, chim, vỗ tay, riser…). Bạn cũng tải được âm thanh của riêng mình.
- **Chỉnh sửa như phần mềm làm nhạc**: Shift+bấm hoặc Shift+kéo khung để chọn nhiều nốt, kéo cả nhóm; Ctrl+C/X/V (dán tại chỗ phát), Ctrl+D nhân đôi, Delete xoá; kéo trên thước ô nhịp để đặt vùng lặp (phím L); máy đếm nhịp khi phát.
- **Khoá**: khoá giai điệu, khoá hợp âm (đổi cảm xúc, hoà âm không đụng tới), khoá lời, khoá căn lời (chữ gắn chặt vào nốt).
- **Ô "Bảo máy làm gì"**: gõ tiếng Việt có dấu hoặc không dấu, ví dụ "nhanh hơn", "tempo 90", "đổi sang buồn", "giọng La thứ", "nâng lên nửa cung", "thêm điệp khúc", "bỏ trống", "dùng sáo trúc", "tắt trống", "biến tấu bản phối".
- **Phối và trộn**: kiểu đệm quạt chả guitar, nút "Biến tấu bản phối" (điệp khúc dày, đoạn chính thưa), nhạc cụ "Synth tự chỉnh" (dạng sóng, bộ lọc, ADSR), mỗi track có trái–phải, EQ 3 dải và độ vang.
- **Giọng hát**: thu giọng theo nhạc nền (có đếm nhịp, bù độ trễ micro), máy chỉnh cao độ về giai điệu hoặc thang âm (độ mạnh, tốc độ kéo nốt, giữ rung giọng), nghe so sánh bản gốc và bản chỉnh, trộn vào bài.
- **Mở file MIDI** (lấy giai điệu, tempo, giọng, hợp âm, lời). **Xuất MIDI (kèm lời), WAV, từng track (stems), gói trọn bài (.zip), lời (.txt) và file bài (JSON)**. Bài được **lưu lên cloud (PostgreSQL)** và mở lại được từ mục "Bài của tôi".

## Kiến trúc

```
ml/         Train model: harmony (POP909, đã train), vn_tone (thanh điệu → giai điệu), humming (dò onset). Xem README từng thư mục
frontend/   React 19 + TypeScript + Vite. Lý thuyết nhạc, sinh giai điệu, đệm, phát nhạc (Web Audio + smplr)
backend/    FastAPI + SQLAlchemy. API lưu bài, API nhận nốt humming (librosa), script đánh giá
Dockerfile  Một image: build frontend rồi FastAPI phục vụ cả API lẫn giao diện
render.yaml Deploy lên Render: web service + PostgreSQL
```

### Luồng humming → bài nhạc

| Bước | Ở đâu | Cách làm |
|---|---|---|
| 1. Giải mã audio | `backend/app/humming/audio.py` | ffmpeg đổi WebM/Opus, M4A, MP3, WAV về mono 16 kHz |
| 2. Dò cao độ | `pitch.py` | pYIN (librosa), bước 10 ms, 65–1050 Hz, kèm xác suất có giọng và năng lượng |
| 3. Tách nốt | `notes.py` | Cắt ở chỗ lặng; trong đoạn liền hơi, làm mượt cao độ bằng trung bình trượt ~1 chu kỳ rung giọng rồi tách khi rời mốc của nốt (bắt được cả bước nửa cung luyến liền); tách nốt lặp ở chỗ năng lượng tụt; gộp mẩu luyến ngắn |
| 3b. Model onset (tuỳ chọn) | `onset_model.py` | Có file `backend/models/humming_onset.json` (train bằng `ml/humming`) thì tách/gộp nốt theo model |
| 3c. Bù lệch chuẩn | `tuning.py` | Người ngân thường lệch La 440 Hz và trôi dần: ước lượng "chuẩn riêng" theo thời gian (trung bình vòng phần lẻ cent, có mở vòng), lấy cao độ phần ổn định của nốt rồi mới làm tròn |
| 4. Dò giọng | `keys.py` | Tương quan với profile Krumhansl–Kessler cho 24 giọng trưởng/thứ |
| 5. Dò tempo | `quantize.py` | Chấm điểm 60–160 BPM theo độ khớp khoảng cách onset với lưới móc đơn và phách, kèm prior quanh 100 BPM |
| 6. Làm tròn nhịp | `quantize.py` | Đưa onset và trường độ về lưới 1/16, dời quãng tám về vùng giai điệu, đưa nốt lạc về thang âm |
| 7. Phối thành bài | `frontend/src/core/humming.ts`, `suggest.ts` | Đặt giai điệu, đổi giọng/tempo nếu muốn, chọn hợp âm bằng Viterbi; bass và trống sinh theo cảm xúc |

Mỗi bản thu và kết quả nhận nốt (kèm tham số, thời gian xử lý) được lưu trong bảng `recordings` và `transcriptions` để phân tích về sau.

## Chạy trên máy

### Cách 1: Docker (giống hệt khi deploy)

```bash
docker compose up --build
```

Mở http://localhost:8000. Compose chạy app cùng PostgreSQL 17, dữ liệu nằm trong volume `pgdata`.

### Cách 2: Chạy riêng từng phần để phát triển

Cần Python 3.12 trở lên và Node 22.

```bash
# Backend (mặc định dùng SQLite: backend/aicomposer.db)
cd backend
python -m venv .venv
.venv/bin/pip install -r requirements-dev.txt      # Windows: .venv\Scripts\pip
.venv/bin/python -m uvicorn app.main:app --reload --port 8000

# Frontend (terminal khác)
cd frontend
npm install
npm run dev
```

Mở http://localhost:5173. Vite tự chuyển `/api` sang backend ở cổng 8000. Không cần cài ffmpeg riêng vì gói `imageio-ffmpeg` đã kèm sẵn.

### Kiểm tra máy

```bash
cd backend && python -m scripts.doctor   # Python, thư viện, ffmpeg, database, model, Node, cổng; in cách sửa từng lỗi
```

### Kiểm thử

```bash
cd frontend && npm test          # lý thuyết nhạc, sinh giai điệu, đệm, MIDI, humming → bài, lời tiếng Việt
cd backend && .venv/bin/python -m pytest   # nhận nốt (F1, tempo, giọng, WebM), API, phân quyền
```

GitHub Actions (`.github/workflows/ci.yml`) chạy cả hai bộ test, build image Docker và gọi thử `/api/health` mỗi lần push.

## Deploy lên Render

1. Đăng nhập https://render.com bằng GitHub.
2. Chọn **New → Blueprint**, chọn repo này. Render đọc `render.yaml` và tạo service `aicomposer` cùng database `aicomposer-db`, rồi tự gán `DATABASE_URL`.
3. Đợi build xong, mở đường dẫn `https://aicomposer-xxxx.onrender.com`. Trang chạy HTTPS nên trình duyệt cho phép thu âm.

Lưu ý gói miễn phí của Render (kiểm tra lại trang giá của Render vì chính sách có thể đổi):

- Service ngủ sau một lúc không có người dùng. Lần mở đầu tiên sau đó mất khoảng một phút để khởi động lại.
- PostgreSQL miễn phí có hạn dùng. Muốn giữ dữ liệu lâu dài, tạo database ở nơi khác (ví dụ Neon, Supabase) rồi đặt biến môi trường `DATABASE_URL` của service sang chuỗi kết nối đó.

Image cũng chạy được ở nơi khác hỗ trợ Docker (Railway, Fly.io, Hugging Face Spaces…) nếu đặt `DATABASE_URL`. Biến `PORT` được đọc tự động.

### Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `DATABASE_URL` | `sqlite:///./aicomposer.db` | Chuỗi kết nối. Nhận cả dạng `postgres://…` của Render/Heroku |
| `MAX_UPLOAD_MB` | `15` | Dung lượng tối đa của file ghi âm |
| `CORS_ORIGINS` | (trống) | Chỉ cần khi frontend nằm ở domain khác, ngăn cách bằng dấu phẩy |
| `HUMMING_MODEL` | `backend/models/humming_onset.json` | File model dò onset; không có file thì dùng cách tách nốt mặc định, `none` để tắt |
| `GEMINI_API_KEY` | (trống) | Bật viết lời và hiểu lệnh tự do bằng AI, dùng Gemini của Google (có gói miễn phí, lấy khoá ở aistudio.google.com). Không có khoá AI nào thì ẩn phần AI, mọi thứ khác vẫn chạy |
| `GROQ_API_KEY` | (trống) | Như trên, dùng Groq (có gói miễn phí, console.groq.com) |
| `ANTHROPIC_API_KEY` | (trống) | Như trên, dùng Claude (trả tiền theo lượt) |
| `AI_API_KEY` + `AI_BASE_URL` | (trống) | Dịch vụ bất kỳ có API kiểu OpenAI (OpenRouter, máy tự chạy...) |
| `AI_PROVIDER` | (tự chọn) | Có nhiều khoá thì chọn `gemini`, `groq`, `anthropic` hoặc `openai`; không đặt thì lấy theo thứ tự đó |
| `AI_MODEL` | tuỳ nhà cung cấp | Mặc định `gemini-flash-latest`, `openai/gpt-oss-120b` (Groq), `claude-opus-5-5` |
| `AI_DAILY_LIMIT` / `AI_DAILY_LIMIT_TOTAL` | `60` / `400` | Số lần gọi AI tối đa mỗi ngày cho mỗi trình duyệt / cả máy chủ, để người lạ không tiêu hết tiền API |
| `WARMUP` | `1` | Chạy nhận nốt thử khi khởi động để lần đầu người dùng không phải chờ biên dịch |

## Model học máy

| Bài toán | Thư mục | Trạng thái |
|---|---|---|
| B. Hoà âm (giai điệu → hợp âm) | `ml/harmony` | Đã train trên 909 bài POP909, file `frontend/src/core/harmonyModel.json`. Kết quả trong `ml/harmony/REPORT.md` |
| A. Thanh điệu → giai điệu (đã train) | `ml/vn_tone` | `frontend/public/models/tone_model.json` học từ 20 bài Việt (ĐH Edinburgh) |
| C. Dò onset khi ngân (đã train) | `ml/humming` | `backend/models/humming_onset.json` học từ HumTrans. Thử độ bền trên giọng khác nguồn (CHAD-Hummings): `ml/humming/CHAD_REPORT.md` |
| D. Mẫu trống | `ml/drums` | Học từ Groove MIDI (tay trống thật), file `frontend/src/core/grooveModel.json`. Bảng Nhạc cụ có nút Tay trống thật / Đều như máy |

Mọi bộ dữ liệu ghi trong `ml/dataset_registry.csv` (nguồn, phiên bản, giấy phép, được train hay chỉ đánh giá). Script train tự dừng nếu bộ dữ liệu chưa có trong sổ hoặc ghi `can_train=false`.

## Dành cho nhà phát triển: đo độ chính xác nhận nốt (không bắt buộc)

App chạy bình thường mà không cần bước này. Script `backend/scripts/eval_humtrans.py` đo note F1 (onset ±50 ms, cao độ ±50 cent, theo `mir_eval`) trên dataset có nhãn MIDI như HumTrans, và dò lưới tham số tách nốt.

```bash
cd backend
.venv/bin/python -m scripts.eval_humtrans --synthetic 40                 # chạy thử không cần dataset
.venv/bin/python -m scripts.eval_humtrans --data /duong/dan/HumTrans --limit 200
.venv/bin/python -m scripts.eval_humtrans --data /duong/dan/HumTrans --grid --out reports/humming_eval.csv
```

Script ghép file audio và MIDI cùng tên, báo F1 thô, F1 sau khi bỏ lệch quãng tám và F1 có tính offset. Kết quả tốt nhất của `--grid` là bộ tham số nên đặt làm mặc định trong `SegmentParams` (`backend/app/humming/notes.py`).

## API

Mọi request gửi header `X-Owner-Key` (khoá ngẫu nhiên trình duyệt tự tạo và giữ). Server chỉ lưu mã băm của khoá, và mỗi khoá chỉ thấy bài của chính nó.

| Method | Đường dẫn | Việc |
|---|---|---|
| GET | `/api/health` | Kiểm tra server và database |
| GET, POST | `/api/projects` | Danh sách bài, tạo bài |
| GET, PUT, DELETE | `/api/projects/{id}` | Xem, sửa, xoá bài |
| POST | `/api/humming` | Gửi file ghi âm (multipart `audio`, tuỳ chọn `bpm`, `tonic`, `mode`, `project_id`), nhận nốt đã làm tròn nhịp |
| GET | `/api/humming/recordings` | Các bản thu đã gửi |
| POST, GET | `/api/vocal/takes` | Gửi bản thu giọng hát (multipart `audio`, `offset_ms`, `bpm`, `project_id`), danh sách bản thu |
| POST | `/api/vocal/takes/{id}/correct` | Chỉnh cao độ (độ mạnh, chế độ giai điệu/thang âm, tốc độ kéo nốt, giữ rung), trả về đường cao độ trước/sau |
| GET, DELETE | `/api/vocal/takes/{id}/audio?version=original\|corrected`, `/api/vocal/takes/{id}` | Nghe bản gốc hoặc bản chỉnh, xoá bản thu |

Tài liệu tương tác: `/docs` (Swagger) khi server đang chạy.
