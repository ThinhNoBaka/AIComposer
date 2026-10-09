# Chỉnh cao độ giọng hát (tab "Giọng hát")

Người dùng thu giọng hát theo bài trên trình duyệt, gửi lên server, rồi chỉnh cao độ kiểu "auto-tune": kéo giọng về
đúng nốt của giai điệu hoặc của thang âm, có thể giữ rung giọng và chỉnh mạnh/nhẹ tuỳ ý. Toàn bộ chạy bằng
numpy/scipy/librosa, không cần thư viện biên dịch thêm.

## API

Mọi request đều cần header `X-Owner-Key` (xem `app/deps.py`). Bản thu của người khác luôn trả `404`.

### `POST /api/vocal/takes` — tải bản thu lên

`multipart/form-data`:

| trường       | kiểu           | ghi chú                                                                 |
|--------------|----------------|-------------------------------------------------------------------------|
| `audio`      | file           | bất kỳ định dạng trình duyệt ghi ra: WebM/Opus, OGG, WAV, MP3...         |
| `project_id` | string, tuỳ chọn | bài nhạc của chính người dùng (bài người khác → `404`)                |
| `offset_ms`  | số, mặc định 0 | bản thu bắt đầu ở mốc này của bài (ms)                                   |
| `bpm`        | số, tuỳ chọn   | 40–220                                                                   |

Server giải mã (ffmpeg) về mono 44.1 kHz rồi lưu dạng WAV PCM16. Trả `201`:

```json
{"id": "uuid", "duration_s": 12.345, "sr": 44100, "offset_ms": 0.0, "bpm": 100.0, "project_id": null}
```

Lỗi: `413` file lớn hơn `MAX_UPLOAD_MB` (mặc định 15 MB, giống API ngân nga) hoặc dài hơn 5 phút;
`400` không giải mã được / quá ngắn; `422` tempo sai.

### `POST /api/vocal/takes/{id}/correct` — chỉnh cao độ

```json
{
  "strength": 1.0,
  "mode": "melody",
  "retune_speed_ms": 20,
  "keep_vibrato": true,
  "key": {"tonic": 9, "mode": "major"},
  "notes": [{"pitch": 69, "start_s": 10.0, "end_s": 10.5}]
}
```

- `strength` 0..1 (mặc định 1): phần độ lệch được bỏ đi. `0` trả lại bản gốc y nguyên từng byte.
- `mode` (mặc định `scale`):
  - `melody`: kéo về nốt giai điệu đang vang tại thời điểm đó (giữ quãng tám người hát, nên hát thấp hơn một
    quãng tám vẫn đúng). Chỗ không có nốt thì kéo về thang của `key`, không có `key` thì về 12 nốt.
    Cần `notes` hoặc `key`.
  - `scale`: kéo về nốt gần nhất trong thang `key` (bắt buộc có `key`).
  - `chromatic`: kéo về nốt gần nhất trong 12 nốt.
- `retune_speed_ms` 0..2000 (mặc định 0): hằng thời gian kéo về nốt. `0` = bám nốt tức thì (hiệu ứng
  "auto-tune" rõ); 20–80 ms nghe tự nhiên hơn; càng lớn thì đầu nốt và đoạn chuyển nốt càng giữ nét gốc.
- `keep_vibrato` (mặc định `true`): chỉ bỏ phần lệch chậm, giữ phần rung nhanh (4–8 Hz) của giọng.
- `key.tonic` 0..11 (0 = Đô), `key.mode` thuộc `major`, `minor`, `dorian`, `majorPentatonic`,
  `minorPentatonic` (giống API ngân nga).
- `notes[].pitch` là số MIDI; `start_s`/`end_s` tính theo **thời gian bài hát** (giây). Server tự trừ
  `offset_ms` của bản thu.

Trả `200`:

```json
{
  "id": "uuid",
  "recipe": {"strength": 1.0, "mode": "melody", "retune_speed_ms": 20.0, "keep_vibrato": true,
             "key": {"tonic": 9, "mode": "major"}, "notes_count": 1},
  "duration_s": 12.345,
  "elapsed_ms": 830,
  "f0": {"hop_s": 0.01, "original": [null, 69.31, 69.29], "corrected": [null, 69.0, 69.0]}
}
```

`f0.original`/`f0.corrected` là cao độ MIDI (số thực) mỗi 10 ms tính từ đầu bản thu, `null` ở chỗ không có giọng;
dùng để vẽ đường cao độ trước/sau. Bản đã chỉnh và `recipe` được lưu lại (ghi đè lần chỉnh trước). Kết quả dò F0
được lưu kèm bản thu nên các lần chỉnh sau không phải dò lại.

Lỗi: `422` thiếu `key` ở chế độ `scale`, thiếu cả `notes` lẫn `key` ở chế độ `melody`, tham số ngoài khoảng.

### `GET /api/vocal/takes/{id}/audio?version=original|corrected`

Trả `audio/wav` (PCM16 mono 44.1 kHz). Mặc định `original`. `corrected` khi chưa chỉnh lần nào → `404`.

### `GET /api/vocal/takes?project_id=...`

Danh sách bản thu của người dùng (tối đa 200, mới nhất trước), lọc theo bài nếu có `project_id`:

```json
[{"id": "uuid", "project_id": "uuid", "created_at": "2026-10-09T08:00:00Z", "duration_s": 12.345, "sr": 44100,
  "offset_ms": 0.0, "bpm": 100.0, "recipe": {"...": "..."}, "has_corrected": true}]
```

### `DELETE /api/vocal/takes/{id}` → `204`

Xoá bài (`DELETE /api/projects/{id}`) cũng xoá các bản thu gắn với bài đó.

## Thuật toán

1. **Dò F0** (`correct.analyze`): hạ bản thu về 16 kHz, chạy pYIN (65–1050 Hz, khung 64 ms, bước 10 ms). Bỏ các đoạn có
   giọng ngắn hơn 40 ms.
2. **Chọn nốt đích** (`correct.correction_curve`), từng đoạn có giọng:
   - làm mượt đường cao độ bằng Gauss (sigma 60 ms) để bỏ rung giọng, rồi chọn nốt gần nhất trong tập nốt được
     phép (nốt giai điệu / thang / 12 nốt). Có trễ (hysteresis) 0.3 nửa cung để giọng lơ lửng giữa hai nốt
     không bị nhảy qua lại.
   - độ lệch = nốt đích − cao độ đã làm mượt (`keep_vibrato`) hoặc − cao độ gốc (bám cứng).
   - độ chỉnh = `strength` × độ lệch, rồi qua bộ lọc mũ một cực bắt đầu từ 0 ở đầu đoạn, hằng thời gian
     `retune_speed_ms` (giống "retune speed" của Auto-Tune).
3. **Đổi cao độ bằng TD-PSOLA** (`psola.psola_shift`), trên audio 44.1 kHz:
   - mốc chu kỳ đặt cách nhau một chu kỳ F0, dời về đỉnh của tín hiệu đã lọc thông thấp quanh tần số cơ bản
     (nội suy parabol lấy phần lẻ mẫu) để các mốc cùng pha;
   - mỗi mốc lấy một hạt dài 2 chu kỳ nhân cửa sổ Hann; đặt lại hạt theo chu kỳ mới = chu kỳ thật / tỉ lệ đổi,
     mỗi vị trí mới dùng hạt có mốc gần nhất nên độ dài giữ nguyên, formant gần như giữ nguyên;
   - cộng chồng rồi chia cho tổng cửa sổ để giữ âm lượng;
   - phần không có giọng (phụ âm, hơi thở, lặng) và đoạn không cần chỉnh giữ nguyên bản gốc, nối bằng crossfade 10 ms.

Tốc độ đo trên CPU 4 nhân: 10 giây audio 44.1 kHz chỉnh hết khoảng 0.7–0.9 s (cả dò F0), các lần chỉnh sau
nhanh hơn vì F0 đã lưu.

Giới hạn đã biết: PSOLA hợp với độ chỉnh nhỏ (dưới khoảng 2–3 nửa cung); dời xa hơn sẽ nghe "rè" và formant
bắt đầu lệch. Giọng có nhạc nền hoặc nhiều tiếng vang sẽ làm pYIN và mốc chu kỳ kém chính xác.

## Mã nguồn

- `psola.py`: TD-PSOLA.
- `correct.py`: dò F0, tính đường chỉnh, ghép với PSOLA (`correct_vocal`).
- `../routes/vocal.py`: API; `../models.py`: bảng `vocal_takes` (tạo bằng `create_all` khi khởi động).
- Test: `backend/tests/test_vocal.py` (giọng giả cao 30 cent, theo giai điệu, giữ rung, tốc độ, WebM, quyền sở hữu).
  Máy chậm có thể nới ngưỡng thời gian bằng `VOCAL_TIMING_FACTOR=3`.
