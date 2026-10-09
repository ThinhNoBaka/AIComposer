# Mô hình dò onset cho humming

Bước tách nốt hiện tại (`backend/app/humming/notes.py`) dựa vào chỗ lặng, chỗ cao độ đổi và chỗ năng lượng tụt.
Cách này hay **gộp nhầm hai nốt cùng cao độ hát liền hơi** và **chẻ nhầm chỗ chỉ hụt hơi**. Ở đây ta học một mô hình nhỏ đoán
khung 10 ms nào là điểm bắt đầu nốt (onset), rồi dùng nó để chẻ/gộp lại các nốt.

## Cách hoạt động

- **Đặc trưng** mỗi khung (tính trong `backend/app/humming/onset_model.py`, dùng chung cho lúc học và lúc chạy):
  cao độ theo cent so với trung vị bản thu, xác suất có giọng (pYIN), độ thay đổi cao độ, năng lượng RMS (dB) và độ thay đổi,
  spectral flux, onset strength; ghép thêm ±3 khung lân cận (49 đặc trưng).
- **Nhãn**: khung cách onset của nốt trong file MIDI không quá 2 khung (20 ms).
- **Mô hình**: MLP một lớp ẩn 16 nơ-ron (hoặc hồi quy logistic với `--hidden 0`), viết bằng numpy, có trọng số cho lớp onset
  (hiếm). Ngưỡng chọn theo F1 onset (±50 ms) trên tập kiểm định.
- **Áp dụng** (`apply_onset_model(notes, track, y)`): nốt có onset dự đoán ở giữa thì chẻ ra; hai nốt liền nhau cùng cao độ
  mà không có onset ở chỗ nối thì gộp lại. Không có file mô hình thì trả nguyên danh sách nốt.
- **Xuất** `backend/models/humming_onset.json`: `version, feature_names, mean, std, layers [{W, b, act}], threshold, hop_length, sr`
  (kèm `context`, `base_features`, `metrics`). Backend chỉ cần numpy để chạy.

## Chạy trên laptop

```bash
pip install -r ml/requirements.txt

# Chạy thử với tiếng ngân giả lập (biết trước nốt), không cần dataset
python ml/humming/train_onset.py --synthetic 60 --out /tmp/humming_onset.json

# Dữ liệu thật dạng HumTrans: thư mục chứa wav + mid cùng tên (tìm đệ quy)
python ml/humming/train_onset.py --data ml/humming/data/HumTrans --limit 2000 --jobs 4 \
    --cache-dir ml/humming/data/cache --out backend/models/humming_onset.json

python -m pytest ml/humming/tests -q
```

Dữ liệu trong `ml/humming/data/` không vào git. Các tuỳ chọn hay dùng: `--keys` (file JSON chia train/valid/test của HumTrans),
`--context`, `--hidden`, `--epochs`, `--eval-limit`.

## Chạy trên Colab

Mở `ml/humming/colab_humming.ipynb`: tải HumTrans từ Hugging Face, trích đặc trưng song song (có cache trên Drive), huấn luyện,
so sánh note F1 (mir_eval) giữa pipeline hiện tại và pipeline có mô hình, rồi tải file JSON về.

## Đưa vào app

1. Chỉ dùng mô hình khi script báo `note F1 ... có mô hình` **cao hơn** pipeline hiện tại.
2. Chép file vào `backend/models/humming_onset.json` và commit. Docker chép thư mục này vào `/app/models` và đặt sẵn
   `HUMMING_MODEL=/app/models/humming_onset.json`.
3. Tắt tạm bằng `HUMMING_MODEL=none`. File hỏng hoặc khác cấu hình (hop 160, sr 16000) sẽ bị bỏ qua kèm cảnh báo trong log.

Pipeline gọi mô hình bằng một dòng sau bước tách nốt, trước bước bù lệch chuẩn, trong `backend/app/humming/pipeline.py`:

```python
from .onset_model import apply_onset_model
...
raw, tuning_cents = retune(apply_onset_model(segment_notes(track, params), track, y), track)
```

Truyền cả `y` (audio đã chuẩn hoá đưa vào `track_pitch`) vì mô hình cần spectral flux và onset strength; thiếu `y` thì hai
đặc trưng này bằng 0 và mô hình kém đi.

Khi đánh giá, `train_onset.py` chạy đúng `transcribe_array` của app hai lần cho mỗi file kiểm định: một lần như hiện tại,
một lần chèn mô hình ở chỗ trên, rồi chấm note F1 bằng mir_eval (bỏ qua lệch quãng tám).
