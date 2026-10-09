"""Kiểm độ bền của bước nhận nốt humming trên CHAD-Hummings (dữ liệu khác nguồn với HumTrans, không có nhãn nốt).

CHAD-Hummings (https://huggingface.co/datasets/amanteur/CHAD_hummings, CC BY-NC 4.0) gồm nhiều người ngân cùng một đoạn
nhạc: thư mục GROUP_ID/FRAGMENT_ID/ID.wav. Không có nhãn nốt nên không tính Note F1. Thay vào đó đo những thứ không cần nhãn:

- Tính nhất quán: hai người ngân cùng một đoạn thì chuỗi quãng (khoảng cách cao độ giữa các nốt liền nhau, không phụ thuộc
  giọng cao hay thấp) phải giống nhau. So độ giống giữa các bản cùng đoạn với các bản khác đoạn: khoảng cách càng lớn thì
  bước nhận nốt càng bám đúng giai điệu, ít phụ thuộc người ngân.
- Dấu hiệu lỗi: file không ra nốt nào, nốt quá ngắn (< 80 ms), bước nhảy quá một quãng tám (thường là lỗi quãng tám),
  số nốt mỗi giây bất thường.

Chạy cho cả cách tách nốt bằng luật (HUMMING_MODEL=none) và có model dò onset, để biết model có làm kém đi trên giọng lạ không.

    python ml/humming/chad_check.py --data /duong/dan/chad --jobs 4 --out ml/humming/CHAD_REPORT.md
"""

from __future__ import annotations

import argparse
import json
import os
import random
import statistics
import sys
import time
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

SHORT_SEC = 0.08


def _transcribe(path: str, use_model: bool) -> list[tuple[float, float, float]]:
    from app.humming.audio import load_audio
    from app.humming.pipeline import TARGET_SR, transcribe_array

    os.environ["HUMMING_MODEL"] = "" if use_model else "none"
    y = load_audio(Path(path).read_bytes(), TARGET_SR)
    out = transcribe_array(y, TARGET_SR)
    return [(n["onset"], n["offset"], n["pitch"]) for n in out["raw_notes"]]


def _work(path: str) -> dict:
    t = time.perf_counter()
    res = {"path": path, "rule": _transcribe(path, False), "model": _transcribe(path, True)}
    res["sec"] = time.perf_counter() - t
    return res


def intervals(notes: list[tuple[float, float, float]]) -> list[int]:
    pitches = [round(p) for _, _, p in notes]
    return [max(-12, min(12, b - a)) for a, b in zip(pitches, pitches[1:])]


def similarity(a: list[int], b: list[int]) -> float:
    """1 − khoảng cách sửa (chuẩn hoá) giữa hai chuỗi quãng; lệch một nửa cung tính nửa lỗi."""
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i] + [0] * len(b)
        for j, y in enumerate(b, 1):
            d = abs(x - y)
            sub = 0.0 if d == 0 else 0.5 if d == 1 else 1.0
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + sub)
        prev = cur
    return 1.0 - prev[-1] / max(len(a), len(b))


def file_stats(notes: list[tuple[float, float, float]], dur: float) -> dict:
    iv = intervals(notes)
    return {
        "empty": not notes,
        "n": len(notes),
        "nps": len(notes) / dur if dur > 0 else 0.0,
        "short": sum(1 for a, b, _ in notes if b - a < SHORT_SEC),
        "octave_jumps": sum(1 for x in iv if abs(x) >= 12),
        "intervals": len(iv),
    }


def summarize(results: list[dict], method: str, rng: random.Random) -> dict:
    by_frag: dict[str, list[list[int]]] = defaultdict(list)
    stats = []
    for r in results:
        notes = r[method]
        dur = max((b for _, b, _ in notes), default=0.0)
        stats.append(file_stats(notes, dur))
        by_frag[str(Path(r["path"]).parent)].append(intervals(notes))
    within = []
    for seqs in by_frag.values():
        for i in range(len(seqs)):
            for j in range(i + 1, len(seqs)):
                within.append(similarity(seqs[i], seqs[j]))
    frags = [k for k, v in by_frag.items() if v]
    between = []
    for _ in range(min(4000, max(1, len(within)))):
        f1, f2 = rng.sample(frags, 2)
        between.append(similarity(rng.choice(by_frag[f1]), rng.choice(by_frag[f2])))
    total_notes = sum(s["n"] for s in stats) or 1
    total_iv = sum(s["intervals"] for s in stats) or 1
    return {
        "files": len(stats),
        "empty_rate": sum(s["empty"] for s in stats) / len(stats),
        "notes_per_sec_median": statistics.median(s["nps"] for s in stats),
        "short_note_rate": sum(s["short"] for s in stats) / total_notes,
        "octave_jump_rate": sum(s["octave_jumps"] for s in stats) / total_iv,
        "within_similarity": statistics.mean(within) if within else 0.0,
        "between_similarity": statistics.mean(between) if between else 0.0,
        "pairs_within": len(within),
    }


def report_md(summary: dict, n_frag: int, seconds: float) -> str:
    rule, model = summary["rule"], summary["model"]

    def row(name: str, key: str, pct: bool = True, better: str = "") -> str:
        f = (lambda v: f"{100 * v:.1f}%") if pct else (lambda v: f"{v:.2f}")
        return f"| {name} | {f(rule[key])} | {f(model[key])} | {better} |"

    margin_r = rule["within_similarity"] - rule["between_similarity"]
    margin_m = model["within_similarity"] - model["between_similarity"]
    return "\n".join(
        [
            "# Kiểm độ bền humming trên CHAD-Hummings",
            "",
            f"{summary['files']} bản ngân của {n_frag} đoạn nhạc (mỗi đoạn nhiều người ngân), chạy mất {seconds:.0f}s. "
            "CHAD không có nhãn nốt nên không có Note F1; các số dưới đây không cần nhãn. Tạo bằng `ml/humming/chad_check.py`.",
            "",
            "| Chỉ số | Tách nốt bằng luật | Có model onset | Tốt hơn khi |",
            "|---|---|---|---|",
            row("Độ giống chuỗi quãng, cùng một đoạn", "within_similarity", better="cao"),
            row("Độ giống chuỗi quãng, khác đoạn (mức nền)", "between_similarity", better="thấp"),
            f"| Khoảng cách hai mức trên | {100 * margin_r:.1f} điểm | {100 * margin_m:.1f} điểm | lớn |",
            row("File không ra nốt nào", "empty_rate", better="thấp"),
            row("Nốt ngắn hơn 80 ms", "short_note_rate", better="thấp"),
            row("Bước nhảy từ một quãng tám", "octave_jump_rate", better="thấp"),
            row("Số nốt mỗi giây (trung vị)", "notes_per_sec_median", pct=False, better="khoảng 2–5"),
            "",
            f"Cặp cùng đoạn đã so: {rule['pairs_within']}.",
            "",
        ]
    )


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--jobs", type=int, default=os.cpu_count() or 1)
    ap.add_argument("--out", type=Path, default=ROOT / "ml" / "humming" / "CHAD_REPORT.md")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args(argv)

    files = sorted(str(p) for p in args.data.rglob("*.wav"))
    if args.limit:
        files = files[: args.limit]
    if not files:
        raise SystemExit(f"Không thấy file .wav trong {args.data}")
    t = time.perf_counter()
    results = []
    with ProcessPoolExecutor(max_workers=args.jobs) as ex:
        for i, r in enumerate(ex.map(_work, files, chunksize=4), 1):
            results.append(r)
            if i % 100 == 0:
                print(f"  {i}/{len(files)} file ({time.perf_counter() - t:.0f}s)", flush=True)
    rng = random.Random(args.seed)
    summary = {m: summarize(results, m, rng) for m in ("rule", "model")}
    summary["files"] = len(results)
    n_frag = len({str(Path(r["path"]).parent) for r in results})
    seconds = time.perf_counter() - t
    md = report_md(summary, n_frag, seconds)
    args.out.write_text(md, encoding="utf-8")
    args.out.with_suffix(".json").write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    print(md)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
