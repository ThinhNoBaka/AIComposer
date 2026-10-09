# Mô hình hoà âm giai điệu → hợp âm (HMM trên POP909)

## Bài toán

Cho giai điệu của một bài (đã biết giọng), chọn cho mỗi ô nhịp một hợp âm trong 7 bậc của thang âm (I..VII).
Đây là việc nút "Hoà âm lại" và tính năng ngân → bài nhạc làm trong frontend (`harmonize` trong
`frontend/src/core/suggest.ts`). Trước đây hàm này chạy theo luật viết tay: đếm nốt giai điệu thuộc hợp âm,
cộng chi phí chuyển hợp âm, thưởng kết về chủ.

## Dữ liệu

[POP909](https://github.com/music-x-lab/POP909-Dataset): 909 bài pop Trung Quốc, mỗi bài có file MIDI tách
track `MELODY`, chú thích hợp âm (`chord_midi.txt`), giọng (`key_audio.txt`) và phách (`beat_midi.txt`).

Tải được đủ 909/909 bài. Sau khi dựng dữ liệu (`build_dataset.py`):

| | Số lượng |
|---|---:|
| Bài dùng được | 909 |
| Ô nhịp | 74 919 |
| Ô có nhãn bậc hợp âm | 72 747 |
| Ô N (không hợp âm) | 974 |
| Ô hợp âm có nốt gốc ngoài thang âm (bỏ, không học) | 1 198 |
| Ô có nốt giai điệu | 57 853 |
| Bài bắt đầu ở giọng trưởng / thứ | 502 / 407 |

Cách dựng:

- Ô nhịp lấy theo cột 3 của `beat_midi.txt` (phách đầu ô 4/4).
- Giọng lấy theo `key_audio.txt`; bài đổi giọng thì mỗi ô theo đoạn giọng chứa nó.
- Hợp âm của ô là hợp âm chiếm lâu nhất trong ô. Nốt gốc quy về bậc 0..6 so với nốt chủ (giọng thứ dùng
  thứ tự nhiên, giống frontend). Hợp âm 7 (`7`, `maj7`, `min7`, `hdim7`, `sus4(b7)`…) ghi thêm cờ.
  Nốt gốc ngoài thang âm (vd. bVII trong giọng trưởng) không quy về bậc gần nhất mà bỏ hẳn, vì đoán sai
  bậc sẽ làm bẩn bảng emission. Số ô này chỉ khoảng 1.6%.
- Giai điệu: histogram 12 lớp cao độ so với nốt chủ (0 = nốt chủ), trọng số là trường độ tính bằng phách.
  Lưu thêm một histogram riêng cho nốt bắt đầu ở phách 1, 3 để chạy lại đúng luật cũ khi so sánh.

## Mô hình

Mỗi giọng (trưởng, thứ) một HMM:

- trạng thái: bậc hợp âm của ô (7 trạng thái);
- `start`: phân phối bậc ở ô đầu, `trans`: ma trận chuyển 7×7 giữa hai ô liền nhau;
- `emit`: với mỗi bậc, phân phối đa thức trên 12 lớp cao độ của giai điệu; log-likelihood của một ô là
  tổng (số phách × log xác suất) của các nốt;
- mọi bảng đếm làm trơn Laplace (+1); `prior` (tần suất từng bậc) và `seventhRate` (tỉ lệ hợp âm 7 theo bậc)
  xuất kèm.

Giải mã bằng Viterbi. Trọng số emission chọn trên 15% của tập huấn luyện (thử 0.25…2), kết quả là 1.0.

Mô hình nặng 2.4 KB (`frontend/src/core/harmonyModel.json`, làm tròn 4 chữ số).

## Kết quả trên tập giữ lại

Chia theo bài (không theo ô) 90/10, seed 909: 818 bài huấn luyện, 91 bài kiểm tra. Chỉ chấm các ô có nhãn
bậc và có nốt giai điệu (3 493 ô giọng trưởng, 2 449 ô giọng thứ). Bảng in ra từ `train.py`:

| Phương pháp | Trưởng | Thứ | Tổng |
|---|---:|---:|---:|
| **HMM (Viterbi)** | **41.4%** | **42.8%** | **42.0%** |
| HMM + thưởng kết về chủ | 41.4% | 42.8% | 42.0% |
| Chỉ emission (từng ô, không dùng chuyển) | 37.9% | 39.3% | 38.5% |
| Luật cũ (`suggest.ts`, chuyển sang Python) | 38.7% | 32.6% | 36.2% |
| Luôn bậc I | 23.3% | 30.5% | 26.3% |
| Top-3 theo độ hợp mới (dùng trong bảng phương án) | 79.1% | 80.8% | 79.8% |
| Top-3 theo `chordFit` cũ | 77.8% | 75.9% | 77.0% |

Nhận xét:

- HMM hơn luật cũ khoảng 6 điểm phần trăm, rõ nhất ở giọng thứ (+10 điểm): luật cũ coi các bậc như nhau,
  còn dữ liệu cho thấy giọng thứ trong pop dùng nhiều VI, VII, III (hợp âm trưởng) và hầu như không dùng II.
- Ma trận chuyển đóng góp khoảng 3.5 điểm so với chọn từng ô độc lập.
- Độ chính xác tuyệt đối thấp vì bài toán khó: chỉ nhìn giai điệu, nhiều ô có hai hợp âm (đổi giữa ô) mà
  nhãn chỉ lấy một, và nhiều hợp âm đều nghe ổn với cùng một giai điệu. Top-3 gần 80% nghĩa là trong
  ba gợi ý đầu của bảng phương án thường có hợp âm mà bài gốc dùng.
- Thưởng kết về chủ không làm thay đổi độ chính xác trên POP909,
  nên frontend giữ nó để bài luôn kết tròn.

## Tích hợp vào frontend

- `frontend/src/core/harmonyModel.ts`: đọc JSON, chuẩn hoá thành log-xác suất, `viterbi()` và `barFit()`.
- `harmonize()` dùng Viterbi của mô hình khi bài ở giọng trưởng/thứ (cả ngũ cung trưởng/thứ, vì hợp âm
  dựng trên thang 7 nốt gốc). Giọng dorian hoặc file mô hình thiếu giọng thì dùng luật cũ
  (`harmonizeByRules`). Ngoài xác suất của mô hình còn cộng: +0.5 nat nếu giữ hợp âm cũ ở ô có nốt,
  +2 nat ở ô không có nốt (giữ hành vi cũ: ô không nốt ưu tiên giữ hợp âm), +3 nat cho bậc I ở ô cuối.
  Ô trống (bậc -1) không được thưởng giữ và vẫn được chọn hợp âm như trước.
- Độ hợp hiển thị trên thang -1..1 (FitMeter): log-tỉ số hợp lý của các nốt dưới hợp âm so với phân phối
  nốt "trung bình", cộng log tiên nghiệm của bậc, chia cho số phách, rồi `tanh(x / 0.4)`.
  Hằng 0.4 chọn để hợp âm đúng trên POP909 có trung vị độ hợp ≈ 0.7. Ô C-E-G-E trong Đô trưởng có độ hợp
  với bậc I ≈ 0.9. Xếp theo điểm này chính là xếp theo xác suất hậu nghiệm của bậc (top-3 79.8% ở trên).
  Ô không có nốt vẫn trả 0.
- `chordFit()` giữ nguyên là độ hợp theo luật (các test cũ dựa trên nó); `melodyFit()` và
  `chordOptions()` dùng mô hình khi có.

## Chạy lại

```bash
pip install -r ml/requirements.txt
python ml/harmony/fetch_pop909.py             # tải vào ml/harmony/data/raw/ (bỏ qua file đã có), --limit N, --workers N
python ml/harmony/build_dataset.py            # → ml/harmony/data/pop909_bars.npz
python ml/harmony/train.py                    # in bảng trên, ghi frontend/src/core/harmonyModel.json
python -m pytest ml/harmony/test_harmony.py   # kiểm thử trên vài bài MIDI giả
```

Toàn bộ quy trình mất khoảng một phút (tải ~35 giây, dựng dữ liệu ~30 giây, huấn luyện ~2 giây).
File JSON xuất ra học trên cả 909 bài; con số trong bảng là của mô hình chỉ học trên 818 bài.
