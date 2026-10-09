"""Huấn luyện mô hình dò onset cho bước tách nốt humming, xuất JSON cho backend.

Đặc trưng mỗi khung 10 ms lấy từ pYIN của backend (cao độ theo cent, xác suất có giọng, độ thay đổi
cao độ, năng lượng RMS, spectral flux, onset strength) và ghép thêm các khung lân cận (cửa sổ ngữ cảnh).
Nhãn: khung nằm gần onset của nốt trong file MIDI đi kèm (định dạng HumTrans: wav + mid cùng tên).
Mô hình: hồi quy logistic (--hidden 0) hoặc MLP một lớp ẩn nhỏ, viết bằng numpy (không cần sklearn).

Cách dùng (chạy từ thư mục gốc repo):
    python ml/humming/train_onset.py --synthetic 60                       # chạy thử, không cần dataset
    python ml/humming/train_onset.py --data /duong/dan/HumTrans --limit 3000 --jobs 4 \
        --cache-dir ml/humming/data/cache --out backend/models/humming_onset.json

Kết quả in ra: F1 của onset trên tập kiểm định và note F1 (mir_eval) của pipeline hiện tại so với
pipeline có mô hình. File JSON được backend tự nạp nếu đặt ở backend/models/humming_onset.json.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import statistics
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from datetime import date
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.humming import onset_model as om  # noqa: E402
from app.humming.audio import TARGET_SR  # noqa: E402
from app.humming.evaluate import note_scores  # noqa: E402
from app.humming.pitch import FRAME, HOP, PitchTrack, track_pitch  # noqa: E402

DEFAULT_OUT = BACKEND / "models" / "humming_onset.json"
HOP_SEC = HOP / TARGET_SR


# ---------- Dữ liệu ----------


def synthetic_items(n: int, seed: int = 0):
    """Tiếng ngân giả lập có nốt biết trước: nhiều nốt lặp lại cùng cao độ và nốt hát liền hơi (khó tách)."""
    from app.humming.synth import synth_hum

    rng = np.random.default_rng(seed)
    scale = [0, 2, 4, 5, 7, 9, 11, 12]
    for i in range(n):
        base = int(rng.choice([48, 55, 60, 64]))
        bpm = rng.uniform(70, 140)
        t, ref, prev = 0.3, [], None
        for _ in range(int(rng.integers(6, 14))):
            beats = float(rng.choice([0.5, 1, 1, 1.5, 2]))
            dur = beats * 60 / bpm
            gap = float(rng.choice([0.0, 0.0, 0.02, 0.05, 0.1]))
            pitch = prev if prev is not None and rng.random() < 0.35 else float(base + rng.choice(scale))
            ref.append((t, t + dur - gap, pitch))
            prev = pitch
            t += dur + (float(rng.uniform(0.2, 0.6)) if rng.random() < 0.1 else 0.0)
        y = synth_hum(
            ref,
            TARGET_SR,
            vibrato_cents=rng.uniform(5, 60),
            detune_cents=rng.uniform(-40, 40),
            noise=rng.uniform(0.003, 0.04),
            seed=seed * 10007 + i,
        )
        yield f"synthetic_{i:04d}", y, ref


def onset_labels(ref: list[tuple[float, float, float]], n: int, width: int) -> np.ndarray:
    """1 cho khung cách onset của nốt nhãn không quá `width` khung, 0 cho phần còn lại."""
    lab = np.zeros(n, dtype=np.float32)
    for on, _, _ in ref:
        f = int(round(on / HOP_SEC))
        lab[max(0, f - width) : min(n, f + width + 1)] = 1.0
    return lab


def _match_rate(ref_arr: np.ndarray, t: np.ndarray, m: np.ndarray, offset: float, scale: float) -> float:
    """Tỉ lệ khung có giọng mà cao độ pYIN khớp (±0,6 nửa cung) nốt nhãn sau khi dời nhãn: t_nhãn * scale + offset."""
    starts, ends, ps = ref_arr[:, 0], ref_arr[:, 1], ref_arr[:, 2]
    rt = (t - offset) / scale
    i = np.clip(np.searchsorted(starts, rt, side="right") - 1, 0, None)
    hit = (rt >= starts[i]) & (rt < ends[i]) & (np.abs(ps[i] - m) < 0.6)
    return float(hit.mean())


def align_reference(ref: list[tuple[float, float, float]], track: PitchTrack) -> tuple[list[tuple[float, float, float]], float]:
    """Căn giờ nhãn MIDI theo tiếng ngân.

    MIDI của HumTrans luôn bắt đầu ở giây 0 còn người ngân vào trễ (thường ~0,2 s), nên onset nhãn lệch hẳn khỏi ±50 ms.
    Dò độ dời (−0,5…1,5 s) rồi tinh chỉnh thêm hệ số co giãn (0,97…1,03) sao cho nhiều khung pYIN khớp cao độ nốt nhãn nhất
    (đã bù lệch quãng tám). Trả về (nhãn đã dời, tỉ lệ khớp); tỉ lệ thấp nghĩa là nhãn không đáng tin.
    """
    v = ~np.isnan(track.midi)
    if v.sum() < 20 or not ref:
        return ref, 0.0
    t, m = track.times[v], track.midi[v]
    arr = np.array(sorted(ref), dtype=float)
    m = m + round((np.median(arr[:, 2]) - np.median(m)) / 12) * 12
    best = max((_match_rate(arr, t, m, off, 1.0), off, 1.0) for off in np.arange(-0.5, 1.5, 0.01))
    _, off0, _ = best
    for sc in np.arange(0.97, 1.0301, 0.005):
        for off in np.arange(off0 - 0.06, off0 + 0.0601, 0.01):
            best = max(best, (_match_rate(arr, t, m, off, sc), off, sc))
    rate, off, sc = best
    return [(a * sc + off, b * sc + off, p) for a, b, p in ref], rate


def normalize(y: np.ndarray) -> np.ndarray:
    """Cắt 60 giây và chuẩn hoá âm lượng giống transcribe_array, để đặc trưng lúc học khớp lúc chạy."""
    from app.humming.pipeline import MAX_SECONDS

    y = np.asarray(y, dtype=np.float32)[: int(MAX_SECONDS * TARGET_SR)]
    peak = float(np.max(np.abs(y))) if len(y) else 0.0
    return y / peak * 0.9 if peak > 0 else y


def process(name: str, y: np.ndarray, ref, context: int, width: int) -> dict:
    y = normalize(y)
    track = track_pitch(y, TARGET_SR)
    x = om.frame_features(track, y, om.BASE_FEATURES, context).astype(np.float32)
    return {"name": name, "x": x, "y": onset_labels(ref, len(x), width), "track": track, "ref": ref, "wave": y}


def _process_file(args) -> dict | None:
    audio, midi, context, width, cache_dir, align = args
    item = _load_file(audio, midi, context, width, cache_dir)
    if item and align:
        # Cache giữ nhãn gốc; căn giờ làm sau khi đọc để đổi cách căn không phải chạy lại pYIN.
        item["ref"], item["align_rate"] = align_reference(item["ref"], item["track"])
        item["y"] = onset_labels(item["ref"], len(item["x"]), width)
    return item


def _load_file(audio: str, midi: str, context: int, width: int, cache_dir: str) -> dict | None:
    key = hashlib.md5(f"{audio}|{context}|{width}".encode()).hexdigest()[:16]
    cache = Path(cache_dir) / f"{Path(audio).stem}_{key}.npz" if cache_dir else None
    if cache and cache.exists():
        d = np.load(cache, allow_pickle=False)
        track = PitchTrack(times=d["times"], midi=d["midi"], voiced_prob=d["vp"], rms=d["rms"], sr=TARGET_SR, hop=HOP)
        ref = [tuple(r) for r in d["ref"].tolist()]
        return {"name": Path(audio).stem, "x": d["x"], "y": d["y"], "track": track, "ref": ref, "audio": audio}
    from scripts.eval_humtrans import load_reference, load_wav

    try:
        ref = load_reference(Path(midi))
        if not ref:
            return None
        item = process(Path(audio).stem, load_wav(Path(audio)), ref, context, width)
        item["audio"] = audio
        del item["wave"]  # không giữ audio trong bộ nhớ; lúc đánh giá đọc lại từ file
    except Exception as exc:  # noqa: BLE001 - file hỏng thì bỏ qua, không dừng cả lượt
        print(f"  bỏ qua {audio}: {exc}", file=sys.stderr)
        return None
    if cache:
        cache.parent.mkdir(parents=True, exist_ok=True)
        tr = item["track"]
        np.savez_compressed(cache, x=item["x"], y=item["y"], times=tr.times, midi=tr.midi, vp=tr.voiced_prob, rms=tr.rms, ref=np.array(ref, dtype=float))
    return item


def load_items(args) -> list[dict]:
    if args.synthetic:
        return [process(n, y, ref, args.context, args.label_width) for n, y, ref in synthetic_items(args.synthetic, args.seed)]
    from scripts.eval_humtrans import find_pairs

    pairs = find_pairs(args.data, args.midi_dir)
    if args.limit:
        rng = np.random.default_rng(args.seed)
        pairs = [pairs[i] for i in sorted(rng.permutation(len(pairs))[: args.limit])]
    if not pairs:
        raise SystemExit(f"Không tìm thấy cặp audio + MIDI cùng tên trong {args.data}")
    cache = str(args.cache_dir) if args.cache_dir else ""
    jobs = [(str(a), str(m), args.context, args.label_width, cache, not args.no_align) for a, m in pairs]
    items: list[dict] = []
    t0 = time.time()
    if args.jobs > 1:
        with ProcessPoolExecutor(args.jobs) as ex:
            for k, it in enumerate(ex.map(_process_file, jobs, chunksize=4)):
                if it:
                    items.append(it)
                if (k + 1) % 100 == 0:
                    print(f"  đã trích đặc trưng {k + 1}/{len(jobs)} file ({time.time() - t0:.0f}s)")
    else:
        for k, j in enumerate(jobs):
            it = _process_file(j)
            if it:
                items.append(it)
            if (k + 1) % 50 == 0:
                print(f"  đã trích đặc trưng {k + 1}/{len(jobs)} file ({time.time() - t0:.0f}s)")
    if not args.no_align:
        rates = np.array([it["align_rate"] for it in items])
        good = [it for it in items if it["align_rate"] >= args.min_align]
        print(
            f"Căn giờ nhãn: tỉ lệ khung khớp trung vị {np.median(rates):.2f}; bỏ {len(items) - len(good)} file khớp dưới "
            f"{args.min_align:.2f} (nhãn không đáng tin)"
        )
        items = good
    return items


def split_items(
    items: list[dict], val_frac: float, seed: int, keys_file: Path | None = None
) -> tuple[list[dict], list[dict], list[dict]]:
    """Chia theo file (không chia theo khung) để tập kiểm định là bản thu mô hình chưa thấy.

    Trả về (train, valid, test). Có file chia tập của HumTrans (khoá TRAIN/VALID/TEST, không phân biệt hoa thường) thì
    valid dùng để chọn ngưỡng, test để chấm note F1 cuối cùng; không có thì test rỗng và valid dùng cho cả hai.
    """
    if keys_file and keys_file.exists():
        keys = {k.lower(): v for k, v in json.loads(keys_file.read_text(encoding="utf-8")).items()}
        valid_names = {Path(k).stem for k in keys.get("valid", [])}
        test_names = {Path(k).stem for k in keys.get("test", [])}
        tr = [it for it in items if it["name"] not in valid_names | test_names]
        va = [it for it in items if it["name"] in valid_names]
        te = [it for it in items if it["name"] in test_names]
        if tr and va:
            return tr, va, te
        if tr and te:
            return tr, te, []
    order = np.random.default_rng(seed).permutation(len(items))
    n_val = max(1, int(round(len(items) * val_frac)))
    val = {int(i) for i in order[:n_val]}
    return [it for i, it in enumerate(items) if i not in val], [it for i, it in enumerate(items) if i in val], []


# ---------- Mô hình (numpy) ----------


def init_layers(n_in: int, hidden: list[int], rng) -> list[dict]:
    dims = [n_in, *hidden, 1]
    layers = []
    for i, (a, b) in enumerate(zip(dims, dims[1:])):
        last = i == len(dims) - 2
        scale = np.sqrt(2.0 / a) if not last else np.sqrt(1.0 / a)
        layers.append({"W": rng.normal(0, scale, (a, b)), "b": np.zeros(b), "act": "sigmoid" if last else "relu"})
    return layers


def forward(layers: list[dict], x: np.ndarray) -> list[np.ndarray]:
    hs = [x]
    for layer in layers:
        z = hs[-1] @ layer["W"] + layer["b"]
        hs.append(1 / (1 + np.exp(-np.clip(z, -50, 50))) if layer["act"] == "sigmoid" else np.maximum(z, 0))
    return hs


def train_mlp(x, y, hidden, epochs, lr, l2, pos_weight, seed, x_val=None, y_val=None) -> list[dict]:
    """BCE có trọng số cho lớp dương (onset hiếm), tối ưu Adam theo mini-batch."""
    rng = np.random.default_rng(seed)
    layers = init_layers(x.shape[1], hidden, rng)
    m = [{k: np.zeros_like(layer[k]) for k in ("W", "b")} for layer in layers]
    v = [{k: np.zeros_like(layer[k]) for k in ("W", "b")} for layer in layers]
    step, batch = 0, 512
    for ep in range(epochs):
        order = rng.permutation(len(x))
        for s in range(0, len(x), batch):
            idx = order[s : s + batch]
            xb, yb = x[idx], y[idx]
            hs = forward(layers, xb)
            wgt = np.where(yb > 0.5, pos_weight, 1.0)
            delta = ((hs[-1][:, 0] - yb) * wgt / wgt.sum())[:, None]  # đạo hàm BCE qua sigmoid
            step += 1
            for li in range(len(layers) - 1, -1, -1):
                grads = {"W": hs[li].T @ delta + l2 * layers[li]["W"], "b": delta.sum(axis=0)}
                if li > 0:
                    delta = (delta @ layers[li]["W"].T) * (hs[li] > 0)
                for k in ("W", "b"):
                    m[li][k] = 0.9 * m[li][k] + 0.1 * grads[k]
                    v[li][k] = 0.999 * v[li][k] + 0.001 * grads[k] ** 2
                    mh = m[li][k] / (1 - 0.9**step)
                    vh = v[li][k] / (1 - 0.999**step)
                    layers[li][k] -= lr * mh / (np.sqrt(vh) + 1e-8)
        if x_val is not None and (ep + 1) % max(1, epochs // 5) == 0:
            p = np.clip(forward(layers, x_val)[-1][:, 0], 1e-7, 1 - 1e-7)
            loss = -np.mean(y_val * np.log(p) + (1 - y_val) * np.log(1 - p))
            print(f"  epoch {ep + 1:3d}: val BCE = {loss:.4f}")
    return layers


# ---------- Đánh giá ----------


def onset_f1(pred_frames: np.ndarray, ref, tol_frames: int = 5) -> tuple[int, int, int]:
    """Số onset đúng (khớp một-một trong ±tol khung), số dự đoán, số nhãn."""
    ref_f = sorted(int(round(on / HOP_SEC)) for on, _, _ in ref)
    used = np.zeros(len(ref_f), dtype=bool)
    hit = 0
    for f in pred_frames:
        best, bi = tol_frames + 1, -1
        for i, r in enumerate(ref_f):
            d = abs(int(f) - r)
            if not used[i] and d < best:
                best, bi = d, i
        if bi >= 0:
            used[bi] = True
            hit += 1
    return hit, len(pred_frames), len(ref_f)


def f1(hit: int, n_pred: int, n_ref: int) -> float:
    p = hit / n_pred if n_pred else 0.0
    r = hit / n_ref if n_ref else 0.0
    return 2 * p * r / (p + r) if p + r else 0.0


def fold_octave(ref, est: list[tuple[float, float, float]]):
    """Người ngân hay lệch cả quãng tám so với nhãn: dịch kết quả theo bội 12 cho khớp trung vị."""
    if not ref or not est:
        return est
    shift = round((np.median([p for *_, p in ref]) - np.median([p for *_, p in est])) / 12) * 12
    return [(a, b, p + shift) for a, b, p in est]


def pipeline_notes(y: np.ndarray, model: om.OnsetModel | None = None) -> list[tuple[float, float, float]]:
    """Chạy đúng pipeline của app (transcribe_array: pYIN → tách nốt → bù lệch chuẩn ...) và lấy nốt thô.

    Có `model` thì chèn apply_onset_model ngay sau bước tách nốt (trước bù lệch chuẩn), giống chỗ backend gọi.
    Mô hình nạp từ HUMMING_MODEL bị tắt trong lúc chạy để so sánh công bằng.
    """
    import os

    from app.humming import pipeline as pl

    old_env = os.environ.get("HUMMING_MODEL")
    os.environ["HUMMING_MODEL"] = "none"
    orig = pl.segment_notes
    if model is not None:
        y_in = normalize(y)

        def seg(track, params=None):
            return om.apply_onset_model(orig(track, params), track, y_in, model)

        pl.segment_notes = seg
    try:
        res = pl.transcribe_array(y, TARGET_SR)
    finally:
        pl.segment_notes = orig
        if old_env is None:
            os.environ.pop("HUMMING_MODEL", None)
        else:
            os.environ["HUMMING_MODEL"] = old_env
    return [(n["onset"], n["offset"], n["pitch"]) for n in res["raw_notes"]]


def evaluate(model: om.OnsetModel, val: list[dict], limit: int) -> dict:
    """Note F1 (mir_eval: onset ±50 ms, cao độ ±50 cent, bỏ qua lệch quãng tám) của pipeline hiện tại và pipeline có mô hình."""
    from scripts.eval_humtrans import load_wav

    base_f, model_f = [], []
    for it in val[:limit]:
        y = it["wave"] if it.get("wave") is not None else load_wav(Path(it["audio"]))
        base = pipeline_notes(y)
        fixed = pipeline_notes(y, model)
        base_f.append(note_scores(it["ref"], fold_octave(it["ref"], base))["f1"])
        model_f.append(note_scores(it["ref"], fold_octave(it["ref"], fixed))["f1"])
    return {
        "files": len(base_f),
        "note_f1_baseline": round(statistics.mean(base_f), 4) if base_f else 0.0,
        "note_f1_model": round(statistics.mean(model_f), 4) if model_f else 0.0,
    }


# ---------- Chạy ----------


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, help="thư mục dataset (wav + mid cùng tên, tìm đệ quy)")
    ap.add_argument("--midi-dir", type=Path, default=None, help="thư mục MIDI nếu để riêng")
    ap.add_argument("--keys", type=Path, default=None, help="file JSON chia train/valid/test của HumTrans (nếu có)")
    ap.add_argument("--no-align", action="store_true", help="không căn giờ nhãn MIDI theo tiếng ngân (xem align_reference)")
    ap.add_argument("--min-align", type=float, default=0.5, help="bỏ file có tỉ lệ khung khớp nhãn sau căn giờ dưới mức này")
    ap.add_argument("--synthetic", type=int, default=0, help="dùng N mẫu giả lập thay cho dataset")
    ap.add_argument("--limit", type=int, default=0, help="chỉ lấy ngẫu nhiên N file")
    ap.add_argument("--jobs", type=int, default=1, help="số tiến trình trích đặc trưng")
    ap.add_argument("--cache-dir", type=Path, default=None, help="lưu đặc trưng từng file để chạy lại nhanh")
    ap.add_argument("--context", type=int, default=3, help="số khung lân cận mỗi bên")
    ap.add_argument("--label-width", type=int, default=2, help="khung cách onset ≤ mức này được gán nhãn 1")
    ap.add_argument("--hidden", type=int, nargs="*", default=[16], help="số nơ-ron mỗi lớp ẩn; --hidden 0 (hoặc không giá trị) = hồi quy logistic")
    ap.add_argument("--epochs", type=int, default=15)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--l2", type=float, default=1e-4)
    ap.add_argument("--neg-keep", type=float, default=0.5, help="giữ ngẫu nhiên tỉ lệ này các khung âm khi huấn luyện")
    ap.add_argument("--val-frac", type=float, default=0.2)
    ap.add_argument("--eval-limit", type=int, default=200, help="số file kiểm định dùng để tính note F1")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args(argv)
    if not args.synthetic and not args.data:
        ap.error("cần --data hoặc --synthetic")
    args.hidden = [h for h in args.hidden if h > 0]

    t0 = time.time()
    items = load_items(args)
    if len(items) < 2:
        raise SystemExit("Cần ít nhất 2 file để chia train/kiểm định.")
    train, val, test = split_items(items, args.val_frac, args.seed, args.keys)
    print(
        f"{len(items)} file ({len(train)} train / {len(val)} kiểm định / {len(test)} test), "
        f"trích đặc trưng mất {time.time() - t0:.0f}s"
    )

    x = np.concatenate([it["x"] for it in train]).astype(np.float64)
    y = np.concatenate([it["y"] for it in train]).astype(np.float64)
    rng = np.random.default_rng(args.seed)
    keep = (y > 0.5) | (rng.random(len(y)) < args.neg_keep)
    x, y = x[keep], y[keep]
    mean = x.mean(axis=0)
    std = x.std(axis=0)
    std = np.where(std > 1e-8, std, 1.0)
    xn = (x - mean) / std
    xv = np.concatenate([it["x"] for it in val]).astype(np.float64)
    yv = np.concatenate([it["y"] for it in val]).astype(np.float64)
    pos = max(1.0, float(y.sum()))
    pos_weight = float(min(10.0, (len(y) - pos) / pos))
    print(f"{len(y)} khung huấn luyện, {int(pos)} khung onset, trọng số lớp dương {pos_weight:.1f}")
    layers = train_mlp(xn, y, args.hidden, args.epochs, args.lr, args.l2, pos_weight, args.seed, (xv - mean) / std, yv)

    names = om.stacked_names(om.BASE_FEATURES, args.context)
    model_json = {
        "version": om.MODEL_VERSION,
        "feature_names": names,
        "base_features": list(om.BASE_FEATURES),
        "context": args.context,
        "mean": mean.tolist(),
        "std": std.tolist(),
        "layers": [{"W": layer["W"].tolist(), "b": layer["b"].tolist(), "act": layer["act"]} for layer in layers],
        "threshold": 0.5,
        "min_gap_frames": 6,
        "merge_tolerance_frames": 4,
        "hop_length": HOP,
        "frame_length": FRAME,
        "sr": TARGET_SR,
    }
    model = om.OnsetModel.from_dict(model_json)

    # Chọn ngưỡng cho F1 onset tốt nhất trên tập kiểm định.
    probs = [model.predict_matrix(it["x"]) for it in val]
    best = (0.0, 0.5)
    for thr in np.arange(0.2, 0.96, 0.05):
        tot = np.zeros(3, dtype=int)
        for it, p in zip(val, probs):
            tot += onset_f1(om.pick_peaks(p, float(thr), model.min_gap_frames), it["ref"])
        best = max(best, (f1(*tot), round(float(thr), 2)))
    model.threshold = model_json["threshold"] = best[1]
    print(f"Ngưỡng tốt nhất {best[1]}: onset F1 (±50 ms) trên tập kiểm định = {best[0]:.3f}")

    metrics = {"onset_f1": round(best[0], 4), "eval_split": "test" if test else "valid", **evaluate(model, test or val, args.eval_limit)}
    print(f"Note F1 trên {metrics['files']} file {metrics['eval_split']}: pipeline hiện tại {metrics['note_f1_baseline']:.3f} → có mô hình {metrics['note_f1_model']:.3f}")
    if metrics["note_f1_model"] < metrics["note_f1_baseline"]:
        print("CHÚ Ý: mô hình đang làm note F1 kém hơn pipeline hiện tại. Đừng chép file này vào backend/models; thử thêm dữ liệu hoặc epoch.")
    model_json["metrics"] = metrics
    model_json["trained_on"] = {
        "source": "synthetic" if args.synthetic else str(args.data.name),
        "files_train": len(train),
        "files_val": len(val),
        "files_test": len(test),
        "date": date.today().isoformat(),
        "hidden": args.hidden,
        "args": {k: (str(v) if isinstance(v, Path) else v) for k, v in vars(args).items() if k not in {"data", "midi_dir", "cache_dir", "out", "keys"}},
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(model_json, ensure_ascii=False), encoding="utf-8")
    print(f"Đã ghi mô hình vào {args.out} ({args.out.stat().st_size / 1024:.0f} KB), tổng thời gian {time.time() - t0:.0f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
