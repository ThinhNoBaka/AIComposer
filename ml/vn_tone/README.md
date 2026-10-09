# Thanh điệu tiếng Việt → giai điệu

Học từ bài hát Việt thật xem **chữ thanh này đi sau chữ thanh kia thì giai điệu thường đi lên hay xuống, bao xa**,
rồi đưa bảng xác suất đó vào app. App dùng bảng ở hai chỗ (`frontend/src/core/lyrics.ts`):

- **Viết giai điệu theo lời**: bước đi giữa hai chữ được rút ngẫu nhiên theo xác suất học được của cặp thanh.
- **Cảnh báo thanh điệu**: báo chữ dễ nghe sai khi bước nhảy đó (cùng hướng, xa từng đó trở lên) hiếm gặp trong bài hát thật
  (xác suất dưới `hint_threshold`, mặc định 0,1).

Bảng hiện có trong `frontend/public/models/tone_model.json` học từ 20 bài hát Việt (khoảng 3.800 chữ) của bộ dữ liệu
Edinburgh (xem bên dưới). Xoá file đó thì app quay về luật có sẵn (sắc, ngã cao; ngang ở giữa; huyền, hỏi, nặng thấp).

## Các file

| File | Việc |
|---|---|
| `vn_common.py` | Thanh điệu (cùng luật với `toneOf` ở frontend), schema, đoán bảng mã, dò giọng, đọc/ghi bảng |
| `extract_symbolic.py` | Karaoke `.kar`/`.mid` (mido) và MusicXML (music21) → bảng chữ |
| `extract_edinburgh.py` | Bộ 20 bài Việt có sẵn nốt và thanh điệu (CSV, ĐH Edinburgh) → bảng chữ |
| `extract_audio.py` | Bản thu thật → tách giọng (Demucs) → F0 (torchcrepe/pYIN) → nốt → căn lời (wav2vec2 CTC) → bảng chữ |
| `colab_vn_tone.ipynb` | Chạy đường audio từng bước trên Colab (GPU), có giải thích |
| `train.py` | Học bảng xác suất, in số liệu đánh giá, xuất `tone_model.json` |
| `tests/test_vn_tone.py` | Tạo file .kar/.mid/MusicXML giả lập, chạy trích → học → kiểm tra JSON |

Bảng chữ (một dòng một chữ): `song_id, artist_id, source, line, idx_in_line, syllable, tone, pitch, onset_beat, dur_beat,
interval_prev, key_tonic, key_mode, melisma_notes`. Ghi ra `syllables.parquet` (thiếu pandas/pyarrow thì `syllables.csv`)
và `manifest.csv` (mỗi file một dòng: bảng mã đã đoán, số chữ, lỗi nếu có).

## Dữ liệu để ở đâu

Mọi thứ trong `ml/vn_tone/data/` **không vào git** (đã có trong `.gitignore`). Xếp mỗi tác giả/ca sĩ một thư mục con:
`train.py` tách train/test theo người (người trong tập test chưa xuất hiện lúc học) nên số liệu mới có ý nghĩa.

```
ml/vn_tone/data/raw/            ← file karaoke, MusicXML
    trinh_cong_son/diem_xua.kar
    van_cao/thien_thai.musicxml
ml/vn_tone/data/audio/          ← bản thu + lời (cho đường audio)
    trinh_cong_son/diem_xua.mp3
    trinh_cong_son/diem_xua.lrc
```

Không xếp theo thư mục được thì đưa thêm `--artists artists.csv` (hai cột `file,artist`).

## Dữ liệu có sẵn: 20 bài của ĐH Edinburgh

Kirby & Ladd, "Tone-melody correspondence in Vietnamese popular song: supplementary materials", Edinburgh DataShare
(https://datashare.ed.ac.uk/handle/10283/2047, CC BY 4.0): 20 bài tân nhạc/dân ca mới, mỗi chữ có nốt (cả nốt luyến),
trường độ, chỗ hết câu và thanh điệu; lời ghi bằng IPA nên thanh lấy từ cột `tone`.

```bash
mkdir -p ml/vn_tone/data/raw/edinburgh && cd ml/vn_tone/data/raw/edinburgh
curl -L -o csv.zip https://datashare.ed.ac.uk/bitstreams/a5134234-8d1a-436c-955a-8b6ac0e28c11/download && unzip -j csv.zip && cd -
python ml/vn_tone/extract_edinburgh.py --input ml/vn_tone/data/raw/edinburgh --out ml/vn_tone/data/processed_edinburgh
python ml/vn_tone/train.py --data ml/vn_tone/data/processed_edinburgh    # thêm --data khác để học chung với file karaoke
```

Kết quả (chia train/test theo bài): đoán đúng hướng lên/ngang/xuống ngang luật cũ (77%), nhưng đoán đúng cả độ xa của bước
nhảy tốt hơn hẳn (log loss 1,37 so với 1,76 khi chỉ nhìn thanh chữ hiện tại), nên giai điệu viết theo lời có bước đi giống bài thật hơn.
Bộ này nhỏ và nghiêng về nhạc miền Bắc; thêm file karaoke của bạn rồi học chung sẽ tốt hơn.

## Chạy trên laptop (karaoke, MusicXML)

```bash
python -m venv .venv-ml && . .venv-ml/bin/activate      # Windows: .venv-ml\Scripts\activate
pip install -r ml/requirements.txt

python ml/vn_tone/extract_symbolic.py --input ml/vn_tone/data/raw --out ml/vn_tone/data/processed
python ml/vn_tone/train.py --data ml/vn_tone/data/processed      # ghi frontend/public/models/tone_model.json
python -m pytest ml/vn_tone/tests -q                              # kiểm tra nhanh (không cần dữ liệu thật)
```

Mẹo với file karaoke:

- Lời trong `.kar` cũ hay gõ bằng bảng mã cũ. Script thử UTF-8, Windows-1258, VNI-Windows rồi chọn bảng cho nhiều chữ tiếng Việt
  hợp lệ nhất; xem cột `encoding` trong `manifest.csv`. Đoán sai thì ép bằng `--encoding vni` (hoặc `cp1258`, `utf-8`).
  Bảng mã TCVN3 (ABC) chưa hỗ trợ.
- Track giai điệu được chọn tự động: track có đầu nốt trùng thời điểm các chữ nhiều nhất. Dưới 50% chữ khớp nốt thì file bị bỏ
  (`manifest.csv` ghi "lời không khớp nốt").
- Giọng (key) mặc định tự dò từ nốt giai điệu; file có key_signature đáng tin thì thêm `--trust-keysig`.
- Câu: dấu `/` hoặc `\` của KAR, xuống dòng trong lời; file không đánh dấu thì cắt ở chỗ lặng từ 1 phách hoặc chữ ngân từ 2 phách
  (giống cách app chia câu nhạc).

## Chạy trên Colab (bản thu thật)

1. Mở `ml/vn_tone/colab_vn_tone.ipynb` trên Colab, chọn GPU T4.
2. Đặt audio + lời lên Google Drive theo cấu trúc trong notebook (lời `.lrc` có mốc thời gian từng câu cho kết quả tốt nhất).
3. Chạy lần lượt các ô: phần 3 chạy thử từng bước trên một bài (nghe giọng đã tách, xem đồ thị cao độ, xem thời điểm từng chữ),
   phần 4 chạy cả thư mục, phần 6 huấn luyện.
4. Tải `tone_model.json` về, chép vào `frontend/public/models/` rồi commit.

Dòng lệnh tương đương (máy có GPU):

```bash
pip install -r ml/requirements.txt demucs torchcrepe "transformers>=4.40" yt-dlp
python ml/vn_tone/extract_audio.py --audio-dir ml/vn_tone/data/audio --out ml/vn_tone/data/processed_audio
python ml/vn_tone/train.py --data ml/vn_tone/data/processed_audio --data ml/vn_tone/data/processed
```

Thuật toán căn lời (CTC Viterbi) viết bằng numpy trong `extract_audio.py`, không phụ thuộc phiên bản torchaudio.

## Đọc số liệu của train.py

- **Log loss** dự đoán nhóm khoảng cách (xuống xa, xuống, xuống bậc, đứng yên, lên bậc, lên, lên xa) trên tập test, so với:
  phân bố đều, phân bố chung, chỉ theo thanh chữ hiện tại, và theo cặp thanh (mô hình dùng trong app). Thấp hơn là tốt hơn.
- **Độ chính xác hướng** (lên / ngang / xuống): đoán theo đa số, theo luật cũ của app (TONE_HEIGHT), theo cặp thanh.
- **LightGBM** (nếu đã `pip install lightgbm`): thêm vị trí trong câu, khoảng cách trước, trường độ, phách… để xem bảng cặp thanh
  còn bỏ sót bao nhiêu thông tin. Chỉ để so sánh trong báo cáo, app không dùng.
- Bảng `P(hướng | thanh trước → thanh này)` cuối cùng học trên toàn bộ dữ liệu, kèm số mẫu `n` của từng cặp.

Cấu trúc `tone_model.json`: `version`, `buckets` (khoảng nửa cung và số bậc tương ứng), `table` (`"thanhTrước|thanhNày"` → xác suất
từng nhóm), `n`, cùng `direction`, `pair_n`, `hint_threshold`, `metrics`, `trained_on` để tham khảo.
