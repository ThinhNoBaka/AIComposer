# backend/models

Chỗ đặt mô hình học máy mà backend nạp lúc chạy. Thư mục được chép vào image Docker (`/app/models`).

| File | Tạo bằng | Dùng ở |
|---|---|---|
| `humming_onset.json` | `ml/humming/train_onset.py` (xem `ml/humming/README.md`) | `app/humming/onset_model.py`: chẻ/gộp nốt theo onset dự đoán |

- **Chưa có file thì app vẫn chạy bình thường**: bước tách nốt giữ nguyên như hiện tại (`notes.py`).
- Đổi đường dẫn bằng biến môi trường `HUMMING_MODEL` (Docker đặt sẵn `/app/models/humming_onset.json`). Đặt `HUMMING_MODEL=none` để tắt mô hình.
- File sai định dạng (khác `version`, khác `hop_length`/`sr`, sai kích thước ma trận) sẽ bị bỏ qua kèm cảnh báo trong log, app quay về cách cũ.
- Chạy suy luận chỉ cần numpy; không cần sklearn hay torch trên server.
- Chỉ chép file vào đây khi script huấn luyện báo note F1 của mô hình cao hơn pipeline hiện tại trên tập kiểm định.
