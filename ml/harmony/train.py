"""Huấn luyện HMM giai điệu → hợp âm (theo bậc) trên dữ liệu ô nhịp của POP909.

Mỗi giọng (trưởng, thứ) một mô hình:
  - start[7]     : xác suất bậc hợp âm của ô đầu tiên;
  - trans[7][7]  : xác suất chuyển bậc giữa hai ô liền nhau;
  - emit[7][12]  : phân phối đa thức của 12 lớp cao độ giai điệu (theo giọng, 0 = nốt chủ)
                   khi ô đang mang hợp âm bậc đó, trọng số theo trường độ;
  - prior[7]     : tần suất từng bậc trên mọi ô (dùng cho điểm độ hợp từng ô);
  - seventhRate[7]: tỉ lệ hợp âm 7 ở từng bậc (để tham khảo).
Mọi bảng đếm đều làm trơn Laplace (cộng 1).

Chia bài 90/10 (theo bài, không theo ô), in độ chính xác trên phần giữ lại của
Viterbi so với luật cũ của frontend (suggest.ts), rồi xuất frontend/src/core/harmonyModel.json.

    python ml/harmony/train.py
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
DEFAULT_DATA = HERE / "data" / "pop909_bars.npz"
DEFAULT_OUT = ROOT / "frontend" / "src" / "core" / "harmonyModel.json"

MODES = ("major", "minor")
SCALES = {"major": (0, 2, 4, 5, 7, 9, 11), "minor": (0, 2, 3, 5, 7, 8, 10)}
LAMBDAS = (0.25, 0.5, 0.75, 1.0, 1.5, 2.0)
FLOOR = 1e-4  # xác suất nhỏ nhất sau khi làm tròn, để log không ra -vô cực


# ---------------------------------------------------------------- dữ liệu


def load(path: Path) -> dict[str, np.ndarray]:
    with np.load(path) as z:
        return {k: z[k] for k in z.files}


def segments(data: dict, song: int) -> list[tuple[int, np.ndarray]]:
    """Chia một bài thành các đoạn cùng giọng (nốt chủ + trưởng/thứ). Trả (mode, chỉ số ô)."""
    a, b = int(data["offsets"][song]), int(data["offsets"][song + 1])
    out = []
    start = a
    for i in range(a + 1, b + 1):
        if i == b or data["mode"][i] != data["mode"][start] or data["tonic"][i] != data["tonic"][start]:
            out.append((int(data["mode"][start]), np.arange(start, i)))
            start = i
    return out


def split_songs(n: int, test_frac: float = 0.1, seed: int = 909) -> tuple[np.ndarray, np.ndarray]:
    perm = np.random.default_rng(seed).permutation(n)
    k = max(1, int(round(n * test_frac))) if n > 1 else 0
    return np.sort(perm[k:]), np.sort(perm[:k])


# ---------------------------------------------------------------- huấn luyện


def fit(data: dict, songs: np.ndarray, alpha: float = 1.0) -> dict:
    deg, sev, hist = data["degree"], data["seventh"], data["hist"]
    counts = {
        m: {
            "start": np.full(7, alpha),
            "trans": np.full((7, 7), alpha),
            "emit": np.full((7, 12), alpha),
            "sev": np.zeros(7),
            "n": np.zeros(7),
        }
        for m in range(len(MODES))
    }
    for s in songs:
        for m, idx in segments(data, int(s)):
            c = counts[m]
            labelled = [i for i in idx if deg[i] >= 0]
            if labelled:
                c["start"][deg[labelled[0]]] += 1
            for i in labelled:
                c["emit"][deg[i]] += hist[i]
                c["sev"][deg[i]] += sev[i]
                c["n"][deg[i]] += 1
            for i, j in zip(idx[:-1], idx[1:]):
                if deg[i] >= 0 and deg[j] >= 0:
                    c["trans"][deg[i], deg[j]] += 1
    model = {}
    for m, c in counts.items():
        model[MODES[m]] = {
            "start": c["start"] / c["start"].sum(),
            "trans": c["trans"] / c["trans"].sum(1, keepdims=True),
            "emit": c["emit"] / c["emit"].sum(1, keepdims=True),
            "prior": (c["n"] + alpha) / (c["n"] + alpha).sum(),
            "seventhRate": c["sev"] / np.maximum(c["n"], 1),
            "bars": int(c["n"].sum()),
        }
    return model


# ---------------------------------------------------------------- giải mã


def fit_scores(mm: dict, H: np.ndarray) -> np.ndarray:
    """Độ hợp từng ô như frontend (harmonyModel.ts) trước khi qua tanh: log-tỉ số hợp lý trên mỗi phách
    so với nền (giai điệu "trung bình"), cộng log tiên nghiệm của bậc chia cho số phách. (n_bar, 7)."""
    bg = mm["prior"] @ mm["emit"]
    w = np.maximum(H.sum(1), 1.0)[:, None]
    lp = np.log(mm["prior"])
    return (H @ np.log(mm["emit"] / bg).T + (lp - lp.mean())[None, :]) / w


def emission_scores(mm: dict, H: np.ndarray, lam: float) -> np.ndarray:
    """Log-likelihood (đã nhân trọng số lam) của từng ô cho từng bậc: (n_bar, 7). Ô không nốt = 0."""
    return lam * H @ np.log(mm["emit"]).T


def viterbi(mm: dict, H: np.ndarray, lam: float, end_tonic: float = 0.0) -> np.ndarray:
    n = len(H)
    em = emission_scores(mm, H, lam)
    lt = np.log(mm["trans"])
    score = np.log(mm["start"]) + em[0]
    back = np.zeros((n, 7), dtype=np.int64)
    for t in range(1, n):
        cand = score[:, None] + lt
        back[t] = cand.argmax(0)
        score = cand.max(0) + em[t]
    score = score.copy()
    score[0] += end_tonic  # thưởng kết về chủ (frontend dùng)
    path = np.zeros(n, dtype=np.int64)
    path[-1] = int(score.argmax())
    for t in range(n - 1, 0, -1):
        path[t - 1] = back[t, path[t]]
    return path


def chord_pcs(mode: str, d: int) -> set[int]:
    sc = SCALES[mode]
    return {sc[(d + k) % 7] for k in (0, 2, 4)}


def rule_fit(mode: str, H: np.ndarray, S: np.ndarray) -> np.ndarray:
    """chordFit() của suggest.ts cho cả 7 bậc: (n_bar, 7), thang -1..1, ô không nốt = 0."""
    W = H + S  # nốt bắt đầu ở phách 1, 3 tính gấp đôi
    tot = W.sum(1)
    out = np.zeros((len(W), 7))
    for d in range(7):
        mask = np.zeros(12, dtype=bool)
        mask[list(chord_pcs(mode, d))] = True
        sc = W[:, mask].sum(1) - 0.6 * W[:, ~mask].sum(1)
        out[:, d] = np.where(tot > 0, sc / np.maximum(tot, 1e-9), 0.0)
    return out


def top3(scores: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Đúng nếu nhãn nằm trong 3 bậc điểm cao nhất (dùng để đổi sang 'dự đoán' cho tiện đếm)."""
    best = np.argsort(-scores, axis=1, kind="stable")[:, :3]
    hit = (best == y[:, None]).any(1)
    return np.where(hit, y, -2)


def rule_harmonize(mode: str, H: np.ndarray, S: np.ndarray) -> np.ndarray:
    """Bản Python của harmonize() theo luật trong frontend/src/core/suggest.ts (hợp âm ba, không có hợp âm cũ)."""
    good = {0: [3, 4, 5], 1: [4, 6], 2: [5, 3], 3: [4, 0, 1], 4: [0, 5], 5: [3, 1, 4], 6: [0, 2]}

    def trans_cost(a: int, b: int) -> float:
        if a == b:
            return 0.35
        return 0.0 if b in good[a] else 0.25

    n = len(H)
    local = -2 * rule_fit(mode, H, S)
    local[:, 6] += 0.4
    local[0, 0] -= 0.4
    local[-1, 0] -= 2
    cost = local[0].copy()
    back = np.zeros((n, 7), dtype=np.int64)
    tc = np.array([[trans_cost(a, b) for b in range(7)] for a in range(7)])
    for t in range(1, n):
        cand = cost[:, None] + tc
        back[t] = cand.argmin(0)
        cost = cand.min(0) + local[t]
    path = np.zeros(n, dtype=np.int64)
    path[-1] = int(cost.argmin())
    for t in range(n - 1, 0, -1):
        path[t - 1] = back[t, path[t]]
    return path


# ---------------------------------------------------------------- đánh giá


def evaluate(data: dict, songs: np.ndarray, model: dict, lam: float) -> dict[str, dict[str, tuple[int, int]]]:
    """Đếm (đúng, tổng) theo từng phương pháp và giọng, chỉ tính ô có nhãn bậc và có nốt giai điệu."""
    methods = ("hmm", "hmm_end", "emit_only", "rules", "always_I", "fit_top3", "rules_top3")
    res = {meth: {m: [0, 0] for m in MODES} for meth in methods}
    deg, hist, strong = data["degree"], data["hist"], data["strong"]
    for s in songs:
        for m, idx in segments(data, int(s)):
            mode = MODES[m]
            mm = model[mode]
            H, S, y = hist[idx], strong[idx], deg[idx]
            preds = {
                "hmm": viterbi(mm, H, lam),
                "hmm_end": viterbi(mm, H, lam, end_tonic=2.0),
                "emit_only": emission_scores(mm, H, lam).argmax(1),
                "rules": rule_harmonize(mode, H, S),
                "always_I": np.zeros(len(idx), dtype=np.int64),
                "fit_top3": top3(fit_scores(mm, H), y),
                "rules_top3": top3(rule_fit(mode, H, S), y),
            }
            ok = (y >= 0) & (H.sum(1) > 0)
            for meth, p in preds.items():
                res[meth][mode][0] += int((p[ok] == y[ok]).sum())
                res[meth][mode][1] += int(ok.sum())
    return {k: {m: tuple(v) for m, v in d.items()} for k, d in res.items()}


def accuracy(r: dict[str, tuple[int, int]], mode: str | None = None) -> float:
    if mode:
        c, n = r[mode]
    else:
        c = sum(v[0] for v in r.values())
        n = sum(v[1] for v in r.values())
    return c / n if n else float("nan")


def tune_lambda(data: dict, train: np.ndarray, seed: int) -> float:
    """Chọn trọng số emission trên một phần nhỏ của tập huấn luyện (không chạm tập kiểm tra)."""
    if len(train) < 10:
        return 1.0
    inner_train, inner_val = split_songs(len(train), 0.15, seed + 1)
    model = fit(data, train[inner_train])
    best, best_acc = 1.0, -1.0
    for lam in LAMBDAS:
        acc = accuracy(evaluate(data, train[inner_val], model, lam)["hmm"])
        if acc > best_acc + 1e-9:
            best, best_acc = lam, acc
    return best


# ---------------------------------------------------------------- xuất


def round_probs(p: np.ndarray) -> list:
    """Làm tròn 4 chữ số, giữ mọi xác suất ≥ FLOOR, mỗi hàng vẫn cộng lại ≈ 1."""
    p = np.maximum(np.asarray(p, dtype=float), FLOOR)
    p = p / p.sum(-1, keepdims=True)
    return np.round(p, 4).tolist()


def export(model: dict, lam: float, n_songs: int, out: Path, held_out: dict | None = None) -> dict:
    doc = {
        "version": 1,
        "source": "POP909",
        "songs": n_songs,
        "emitWeight": lam,
        "modes": {
            mode: {
                "start": round_probs(mm["start"]),
                "trans": round_probs(mm["trans"]),
                "emit": round_probs(mm["emit"]),
                "prior": round_probs(mm["prior"]),
                "seventhRate": np.round(mm["seventhRate"], 4).tolist(),
            }
            for mode, mm in model.items()
        },
    }
    if held_out:
        doc["heldOut"] = held_out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, separators=(",", ":")) + "\n")
    return doc


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, default=DEFAULT_DATA)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--seed", type=int, default=909)
    ap.add_argument("--lam", type=float, default=None, help="trọng số emission; bỏ trống thì tự chọn")
    args = ap.parse_args(argv)

    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from registry import require_trainable

    require_trainable("pop909")
    data = load(args.data)
    n = len(data["song_ids"])
    train, test = split_songs(n, 0.1, args.seed)
    lam = args.lam if args.lam is not None else tune_lambda(data, train, args.seed)
    print(f"{n} bài: {len(train)} huấn luyện, {len(test)} kiểm tra; trọng số emission = {lam}")

    model = fit(data, train)
    res = evaluate(data, test, model, lam)
    names = {
        "hmm": "HMM (Viterbi)",
        "hmm_end": "HMM + thưởng kết về chủ",
        "emit_only": "Chỉ emission (từng ô)",
        "rules": "Luật cũ (suggest.ts)",
        "always_I": "Luôn bậc I",
        "fit_top3": "Top-3 theo độ hợp mới",
        "rules_top3": "Top-3 theo chordFit cũ",
    }
    print(f"\n{'Phương pháp':28s} {'Trưởng':>8s} {'Thứ':>8s} {'Tổng':>8s}")
    for k, label in names.items():
        print(f"{label:28s} {accuracy(res[k], 'major'):8.1%} {accuracy(res[k], 'minor'):8.1%} {accuracy(res[k]):8.1%}")
    print(f"(số ô đánh giá: trưởng {res['hmm']['major'][1]}, thứ {res['hmm']['minor'][1]})")

    held = {
        "songs": int(len(test)),
        "bars": int(sum(v[1] for v in res["hmm"].values())),
        "hmm": round(accuracy(res["hmm"]), 4),
        "rules": round(accuracy(res["rules"]), 4),
    }
    # Mô hình xuất ra frontend học trên toàn bộ dữ liệu.
    final = fit(data, np.arange(n))
    export(final, lam, n, args.out, held)
    print(f"\nĐã ghi {args.out} ({args.out.stat().st_size} byte)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
