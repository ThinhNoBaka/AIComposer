# Kiểm độ bền humming trên CHAD-Hummings

1200 bản ngân của 144 đoạn nhạc (mỗi đoạn nhiều người ngân), chạy mất 490s. CHAD không có nhãn nốt nên không có Note F1; các số dưới đây không cần nhãn. Tạo bằng `ml/humming/chad_check.py`.

| Chỉ số | Tách nốt bằng luật | Có model onset | Tốt hơn khi |
|---|---|---|---|
| Độ giống chuỗi quãng, cùng một đoạn | 42.3% | 42.3% | cao |
| Độ giống chuỗi quãng, khác đoạn (mức nền) | 28.0% | 28.8% | thấp |
| Khoảng cách hai mức trên | 14.3 điểm | 13.5 điểm | lớn |
| File không ra nốt nào | 0.2% | 0.2% | thấp |
| Nốt ngắn hơn 80 ms | 0.1% | 0.2% | thấp |
| Bước nhảy từ một quãng tám | 0.4% | 0.3% | thấp |
| Số nốt mỗi giây (trung vị) | 2.01 | 2.13 | khoảng 2–5 |

Cặp cùng đoạn đã so: 6704.
Nhận xét: trên giọng lạ, model onset ngang cách tách bằng luật (cùng độ giống 42,3%). Lần chạy đầu (mảnh chẻ tối thiểu 50 ms)
model tạo 2,0% nốt ngắn dưới 80 ms; đã nâng lên 80 ms (`MIN_PART_FRAMES = 8` trong `backend/app/humming/onset_model.py`),
nốt vụn còn 0,2% mà note F1 trên 279 file test HumTrans gần như không đổi (0,434 → 0,433, cách cũ 0,422).
