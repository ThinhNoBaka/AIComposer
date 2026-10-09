# Mẫu trống học từ Groove MIDI

`train_groove.py` học từ [Groove MIDI Dataset](https://magenta.tensorflow.org/datasets/groove) (khoảng 13 giờ tay trống thật
chơi trên trống điện, CC BY 4.0) và ghi `frontend/src/core/grooveModel.json`. Giao diện dùng bảng này khi bài để
"Tay trống thật" (mặc định, bảng Nhạc cụ); "Đều như máy" giữ mẫu viết tay cũ.

```bash
curl -L -o ml/drums/data/groove.zip https://storage.googleapis.com/magentadata/datasets/groove/groove-v1.0.0-midionly.zip
python ml/drums/train_groove.py --zip ml/drums/data/groove.zip --out frontend/src/core/grooveModel.json
python -m pytest ml/drums -q
```

## Học gì

| Kiểu trống của app | Phong cách Groove dùng để học |
|---|---|
| pop (Vui tươi) | pop, rock, country, 80–140 BPM |
| ballad (Buồn, Lãng mạn, Dân gian) | soul, gospel, blues và rock/pop/country chậm dưới 92 BPM |
| lofi (Chill) | hiphop |
| dance (Sôi động) | dance, funk, afrobeat từ 90 BPM |
| epic (Hào hùng) | chưa có dữ liệu hợp, giữ mẫu viết tay |

- **Căn phách:** bản ghi có thể không bắt đầu đúng phách 1; chọn độ lệch để snare rơi vào phách 2, 4 và kick vào phách 1.
- **Mẫu chính của mỗi bản:** bước nào có nốt chắc (không tính nốt lướt dưới lực 0,3) ở từ nửa số ô trở lên. Mỗi bản một
  phiếu; giữ 10 mẫu nhiều phiếu nhất có kick phách 1 và snare phách 2 hoặc 4.
- **Cảm giác:** lực đánh trung bình và độ lệch nhịp trung bình ở từng bước của từng tiếng. App áp một nửa độ lệch (tối đa
  1/8 bước) để nghe như người chơi mà không lệch phách.
- **Dồn trống:** từ các bản "fill", lấy ô nhiều snare/tom nhất; app thay nửa sau ô cuối mỗi câu nhạc bằng mẫu này.

Mỗi đoạn bài (hoặc mỗi 8 ô) chọn một mẫu theo độ dày (thưa: mẫu ít nốt, dày: mẫu nhiều nốt). "Biến tấu bản phối" đổi mẫu.
