"""Chạy: python -m pytest ml/test_registry.py -q"""

import csv

import pytest

import registry


def test_registry_is_well_formed():
    with registry.REGISTRY.open(encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        assert reader.fieldnames == registry.FIELDS
        rows = list(reader)
    assert len({r["asset_id"] for r in rows}) == len(rows)
    for r in rows:
        assert r["rights_status"] in registry.RIGHTS, r["asset_id"]
        assert r["can_train"] in {"true", "false"} and r["can_redistribute"] in {"true", "false"}
        assert r["license_id"], r["asset_id"]
    assert set(registry.VN_TONE_SOURCES.values()) <= {r["asset_id"] for r in rows}


def test_require_trainable():
    assert registry.require_trainable("groove_midi", "humtrans")[0]["license_id"] == "CC-BY-4.0"
    with pytest.raises(SystemExit, match="can_train=false"):
        registry.require_trainable("chad_hummings")
    with pytest.raises(SystemExit, match="chưa có"):
        registry.require_trainable("khong_co")
