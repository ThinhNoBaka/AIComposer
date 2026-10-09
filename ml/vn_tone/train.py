"""Học bảng "thanh điệu → hướng giai điệu" từ bảng chữ đã trích, xuất JSON cho frontend.

Mô hình chính (dùng trong app): bảng xác suất P(khoảng cách cao độ | thanh chữ trước, thanh chữ này),
khoảng cách chia thành 7 nhóm (xuống xa, xuống, xuống bậc, đứng yên, lên bậc, lên, lên xa), làm trơn
bằng cách lùi dần về P(nhóm | thanh chữ này) rồi về phân bố chung. Kèm P(hướng | cặp thanh).
Mô hình phụ (chỉ để so sánh trong báo cáo): LightGBM nếu đã cài.

Chia train/test theo ca sĩ/nhạc sĩ (artist_id) để đo khả năng tổng quát sang người viết khác.
Số liệu in ra để đưa vào báo cáo; file JSON cuối cùng học trên toàn bộ dữ liệu.

Cách dùng (từ thư mục gốc repo):
    python ml/vn_tone/train.py --data ml/vn_tone/data/processed
    python ml/vn_tone/train.py --data a.parquet --data b.csv --out frontend/public/models/tone_model.json
"""

from __future__ import annotations

import argparse
import json
import math
import random
import sys
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from vn_common import TONES, read_rows  # noqa: E402

ROOT = HERE.parents[1]
DEFAULT_OUT = ROOT / "frontend" / "public" / "models" / "tone_model.json"
MODEL_VERSION = 1

# Nhóm khoảng cách (nửa cung) và số bậc thang âm tương ứng mà frontend dùng khi sinh giai điệu.
BUCKETS = [
    {"name": "down_big", "lo": -24, "hi": -5, "deg": -3},
    {"name": "down", "lo": -4, "hi": -3, "deg": -2},
    {"name": "down_step", "lo": -2, "hi": -1, "deg": -1},
    {"name": "same", "lo": 0, "hi": 0, "deg": 0},
    {"name": "up_step", "lo": 1, "hi": 2, "deg": 1},
    {"name": "up", "lo": 3, "hi": 4, "deg": 2},
    {"name": "up_big", "lo": 5, "hi": 24, "deg": 3},
]
K = len(BUCKETS)
DIRECTIONS = ("down", "same", "up")
# Luật cũ của frontend (TONE_HEIGHT trong lyrics.ts), để so sánh.
TONE_HEIGHT = {"sac": 2, "nga": 2, "ngang": 1, "hoi": 0, "huyen": 0, "nang": 0}


def bucket_of(interval: int) -> int:
    iv = max(-24, min(24, int(interval)))
    for i, b in enumerate(BUCKETS):
        if b["lo"] <= iv <= b["hi"]:
            return i
    raise ValueError(interval)


def direction_of_bucket(i: int) -> int:
    deg = BUCKETS[i]["deg"]
    return 0 if deg < 0 else 1 if deg == 0 else 2


def make_samples(rows: list[dict]) -> list[dict]:
    """Mỗi mẫu = một chữ (không phải đầu câu) kèm thanh của chữ trước trong cùng câu."""
    lines: dict[tuple, list[dict]] = defaultdict(list)
    for r in rows:
        lines[(r["song_id"], r["line"])].append(r)
    out = []
    for (song, _line), rs in lines.items():
        rs.sort(key=lambda r: r["idx_in_line"])
        for k in range(1, len(rs)):
            cur, prev = rs[k], rs[k - 1]
            if cur["tone"] not in TONES or prev["tone"] not in TONES:
                continue
            iv = cur["interval_prev"] if cur["interval_prev"] is not None else cur["pitch"] - prev["pitch"]
            out.append(
                {
                    "song_id": song,
                    "artist_id": cur["artist_id"],
                    "prev": prev["tone"],
                    "tone": cur["tone"],
                    "interval": int(iv),
                    "bucket": bucket_of(iv),
                    "pos": k,
                    "is_last": k == len(rs) - 1,
                    "prev_interval": rs[k - 1]["interval_prev"] if rs[k - 1]["interval_prev"] is not None else 0,
                    "dur_beat": cur["dur_beat"],
                    "beat_frac": cur["onset_beat"] % 1.0,
                    "melisma": cur["melisma_notes"],
                    "minor": cur["key_mode"] == "minor",
                }
            )
    return out


class ToneTable:
    """P(nhóm | thanh trước, thanh này) làm trơn kiểu lùi dần (Dirichlet): cặp → thanh này → chung."""

    def __init__(self, alpha: float = 5.0):
        self.alpha = alpha

    def fit(self, samples: list[dict]) -> ToneTable:
        a = self.alpha
        g = Counter(s["bucket"] for s in samples)
        n = len(samples)
        self.glob = [(g[i] + 1) / (n + K) for i in range(K)]
        by_tone: dict[str, Counter] = defaultdict(Counter)
        by_pair: dict[str, Counter] = defaultdict(Counter)
        for s in samples:
            by_tone[s["tone"]][s["bucket"]] += 1
            by_pair[f"{s['prev']}|{s['tone']}"][s["bucket"]] += 1
        self.tone = {}
        for t in TONES:
            c = by_tone[t]
            m = sum(c.values())
            self.tone[t] = [(c[i] + a * self.glob[i]) / (m + a) for i in range(K)]
        self.table, self.pair_n = {}, {}
        for p in TONES:
            for t in TONES:
                key = f"{p}|{t}"
                c = by_pair[key]
                m = sum(c.values())
                self.table[key] = [(c[i] + a * self.tone[t][i]) / (m + a) for i in range(K)]
                self.pair_n[key] = m
        self.n = n
        return self

    def proba(self, s: dict) -> list[float]:
        return self.table[f"{s['prev']}|{s['tone']}"]

    def direction(self) -> dict[str, list[float]]:
        out = {}
        for key, probs in self.table.items():
            d = [0.0, 0.0, 0.0]
            for i, p in enumerate(probs):
                d[direction_of_bucket(i)] += p
            out[key] = [round(x, 5) for x in d]
        return out


def split_by_artist(samples: list[dict], test_frac: float, seed: int) -> tuple[list[dict], list[dict], str]:
    """Chia theo ca sĩ/nhạc sĩ; chỉ có một người thì chia theo bài."""
    for field in ("artist_id", "song_id"):
        groups = sorted({s[field] for s in samples})
        if len(groups) >= 2:
            rng = random.Random(seed)
            rng.shuffle(groups)
            n_test = max(1, round(len(groups) * test_frac))
            test = set(groups[:n_test])
            return [s for s in samples if s[field] not in test], [s for s in samples if s[field] in test], field
    return samples, [], "none"


def log_loss(probs: list[list[float]], ys: list[int]) -> float:
    return -sum(math.log(max(p[y], 1e-12)) for p, y in zip(probs, ys)) / max(1, len(ys))


def accuracy(probs: list[list[float]], ys: list[int]) -> float:
    return sum(max(range(len(p)), key=p.__getitem__) == y for p, y in zip(probs, ys)) / max(1, len(ys))


def rule_direction(s: dict) -> int:
    d = TONE_HEIGHT[s["tone"]] - TONE_HEIGHT[s["prev"]]
    return 0 if d < 0 else 1 if d == 0 else 2


def evaluate(train: list[dict], test: list[dict], alpha: float) -> dict:
    model = ToneTable(alpha).fit(train)
    ys = [s["bucket"] for s in test]
    dirs = [direction_of_bucket(y) for y in ys]
    uniform = [[1 / K] * K for _ in test]
    glob = [model.glob for _ in test]
    tone_only = [model.tone[s["tone"]] for s in test]
    pair = [model.proba(s) for s in test]

    def dir_probs(ps):
        out = []
        for p in ps:
            d = [0.0, 0.0, 0.0]
            for i, x in enumerate(p):
                d[direction_of_bucket(i)] += x
            out.append(d)
        return out

    return {
        "n_train": len(train),
        "n_test": len(test),
        "logloss_uniform": log_loss(uniform, ys),
        "logloss_global": log_loss(glob, ys),
        "logloss_tone": log_loss(tone_only, ys),
        "logloss_pair": log_loss(pair, ys),
        "acc_global": accuracy(glob, ys),
        "acc_pair": accuracy(pair, ys),
        "dir_acc_majority": accuracy(dir_probs(glob), dirs),
        "dir_acc_rule": sum(rule_direction(s) == d for s, d in zip(test, dirs)) / max(1, len(test)),
        "dir_acc_pair": accuracy(dir_probs(pair), dirs),
    }


def try_lightgbm(train: list[dict], test: list[dict], seed: int) -> dict | None:
    try:
        import lightgbm as lgb
        import numpy as np
    except ImportError:
        print("  (chưa cài lightgbm: bỏ qua mô hình phụ. pip install lightgbm để so sánh thêm)")
        return None
    if len(train) < 50 or not test:
        print("  (quá ít mẫu cho LightGBM: bỏ qua)")
        return None
    idx = {t: i for i, t in enumerate(TONES)}

    def feats(ss):
        return np.array(
            [
                [idx[s["prev"]], idx[s["tone"]], s["pos"], s["is_last"], max(-12, min(12, s["prev_interval"])), s["dur_beat"], s["beat_frac"], s["melisma"], s["minor"]]
                for s in ss
            ],
            dtype=float,
        )

    xtr, xte = feats(train), feats(test)
    ytr, yte = [s["bucket"] for s in train], [s["bucket"] for s in test]
    clf = lgb.LGBMClassifier(
        objective="multiclass", num_class=K, n_estimators=200, learning_rate=0.05, num_leaves=15, min_child_samples=20, random_state=seed, verbose=-1
    )
    present = sorted(set(ytr))
    clf.fit(xtr, ytr, categorical_feature=[0, 1])
    raw = clf.predict_proba(xte)
    probs = []
    for row in raw:  # lớp không có trong train thì xác suất 0 → làm trơn nhẹ
        full = [1e-3] * K
        for j, c in enumerate(present):
            full[c] += row[j]
        z = sum(full)
        probs.append([x / z for x in full])
    return {"logloss_lgbm": log_loss(probs, yte), "acc_lgbm": accuracy(probs, yte)}


def print_report(metrics: dict, field: str, table: ToneTable) -> None:
    print(f"\nĐánh giá (tách theo {field}): {metrics['n_train']} mẫu train, {metrics['n_test']} mẫu test")
    print("  Log loss nhóm khoảng cách (thấp hơn là tốt hơn):")
    for k, label in (("uniform", "đều"), ("global", "phân bố chung"), ("tone", "theo thanh chữ này"), ("pair", "theo cặp thanh"), ("lgbm", "LightGBM")):
        if f"logloss_{k}" in metrics:
            print(f"    {label:22s} {metrics[f'logloss_{k}']:.4f}")
    print(f"  Độ chính xác nhóm: chung {metrics['acc_global']:.3f} | cặp thanh {metrics['acc_pair']:.3f}" + (f" | LightGBM {metrics['acc_lgbm']:.3f}" if "acc_lgbm" in metrics else ""))
    print(f"  Độ chính xác hướng (lên/ngang/xuống): đa số {metrics['dir_acc_majority']:.3f} | luật TONE_HEIGHT {metrics['dir_acc_rule']:.3f} | cặp thanh {metrics['dir_acc_pair']:.3f}")
    print("\nP(hướng | thanh trước → thanh này) trên toàn bộ dữ liệu (xuống / ngang / lên, n):")
    d = table.direction()
    for key in sorted(table.table, key=lambda k: -table.pair_n[k])[:36]:
        if table.pair_n[key]:
            down, same, up = d[key]
            print(f"    {key:14s} {down:.2f} / {same:.2f} / {up:.2f}   n={table.pair_n[key]}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, action="append", help="file .parquet/.csv hoặc thư mục (dùng nhiều lần được)")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--alpha", type=float, default=5.0, help="độ làm trơn (số mẫu ảo lùi về mức thô hơn)")
    ap.add_argument("--test-frac", type=float, default=0.2)
    ap.add_argument("--hint-threshold", type=float, default=0.1, help="xác suất dưới mức này thì app cảnh báo chữ dễ nghe sai")
    ap.add_argument("--min-samples", type=int, default=30, help="ít mẫu hơn thì không xuất (tránh mô hình rác)")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args(argv)
    paths = args.data or [HERE / "data" / "processed"]
    rows = [r for p in paths for r in read_rows(p)]
    samples = make_samples(rows)
    print(f"{len(rows)} chữ, {len(samples)} cặp chữ liền nhau trong câu, {len({r['song_id'] for r in rows})} bài, {len({r['artist_id'] for r in rows})} tác giả")
    if len(samples) < args.min_samples:
        print(f"Quá ít mẫu (< {args.min_samples}): không xuất mô hình.", file=sys.stderr)
        return 1

    train, test, field = split_by_artist(samples, args.test_frac, args.seed)
    final = ToneTable(args.alpha).fit(samples)
    metrics: dict = {}
    if test:
        metrics = evaluate(train, test, args.alpha)
        lg = try_lightgbm(train, test, args.seed)
        if lg:
            metrics.update(lg)
        print_report(metrics, field, final)

    model = {
        "version": MODEL_VERSION,
        "buckets": BUCKETS,
        "tones": list(TONES),
        "table": {k: [round(p, 5) for p in v] for k, v in final.table.items()},
        "direction": final.direction(),
        "pair_n": final.pair_n,
        "n": final.n,
        "hint_threshold": args.hint_threshold,
        "alpha": args.alpha,
        "metrics": {k: round(v, 4) if isinstance(v, float) else v for k, v in metrics.items()},
        "trained_on": {
            "songs": len({r["song_id"] for r in rows}),
            "artists": len({r["artist_id"] for r in rows}),
            "sources": sorted({r["source"] for r in rows}),
            "split": field,
            "date": date.today().isoformat(),
        },
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(model, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\nĐã ghi {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
