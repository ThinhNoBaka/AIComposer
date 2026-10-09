"""Sổ nguồn dữ liệu (ml/dataset_registry.csv): nguồn, phiên bản, giấy phép, được làm gì với từng bộ dữ liệu.

Script train gọi require_trainable(...) trước khi học: bộ nào chưa có trong sổ, hoặc ghi can_train khác true, thì dừng.
Thêm dữ liệu mới: thêm một dòng vào CSV (đọc giấy phép trước), rồi mới train.
"""

from __future__ import annotations

import csv
from pathlib import Path

REGISTRY = Path(__file__).with_name("dataset_registry.csv")
FIELDS = [
    "asset_id", "name", "source_url", "source_version", "download_date", "sha256", "license_id", "license_url",
    "usage_scope", "rights_status", "can_train", "can_redistribute", "annotation_version", "split", "used_by", "notes",
]
RIGHTS = {"approved_for_scope", "restricted", "unknown"}


def load(path: Path = REGISTRY) -> dict[str, dict]:
    with path.open(encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))
    return {r["asset_id"]: r for r in rows}


def require_trainable(*asset_ids: str, path: Path = REGISTRY) -> list[dict]:
    reg = load(path)
    out = []
    for a in asset_ids:
        r = reg.get(a)
        if r is None:
            raise SystemExit(f"Bộ dữ liệu '{a}' chưa có trong {path.name}. Thêm một dòng (nguồn, giấy phép, can_train) rồi train lại.")
        if r["can_train"].strip().lower() != "true":
            raise SystemExit(f"Bộ dữ liệu '{a}' ghi can_train={r['can_train']} trong {path.name} ({r['usage_scope']}): không dùng để train.")
        out.append(r)
    return out


# Nguồn ghi trong cột `source` của bảng chữ ml/vn_tone → dòng trong sổ.
VN_TONE_SOURCES = {"edinburgh": "edinburgh_vn_songs", "kar": "user_lyric_songs", "midi": "user_lyric_songs", "musicxml": "user_lyric_songs", "audio": "user_lyric_songs"}
