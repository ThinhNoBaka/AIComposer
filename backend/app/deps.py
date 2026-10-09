import hashlib

from fastapi import Header, HTTPException


def owner_id(x_owner_key: str | None = Header(default=None)) -> str:
    """Mỗi trình duyệt tự sinh một khoá bí mật và gửi kèm mọi request.

    Server chỉ lưu bản băm, nên lộ database cũng không lộ khoá. Đây chưa phải đăng nhập thật:
    ai có khoá thì xem được bài của khoá đó.
    """
    if not x_owner_key or len(x_owner_key) < 16 or len(x_owner_key) > 200:
        raise HTTPException(status_code=401, detail="Thiếu hoặc sai khoá người dùng (X-Owner-Key).")
    return hashlib.sha256(x_owner_key.encode()).hexdigest()
