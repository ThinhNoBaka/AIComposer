"""Học kiểu trống từ Groove MIDI Dataset (tay trống thật chơi trên trống điện), xuất bảng cho giao diện.

Nguồn: https://magenta.tensorflow.org/datasets/groove (giấy phép CC BY 4.0). Tải bản chỉ có MIDI (khoảng 3 MB):
    curl -L -o ml/drums/data/groove.zip https://storage.googleapis.com/magentadata/datasets/groove/groove-v1.0.0-midionly.zip
    python ml/drums/train_groove.py --zip ml/drums/data/groove.zip --out frontend/src/core/grooveModel.json

Học gì: mỗi kiểu trống của app (pop, ballad, lofi, dance) lấy các bản "beat" 4/4 của vài phong cách Groove gần nghĩa nhất,
chia từng ô nhịp thành 16 bước (móc kép), rồi giữ:
- các mẫu ô nhịp hay gặp nhất (kick, snare, hi-hat đóng/mở) kèm tần suất, để mỗi đoạn bài chọn một mẫu tay trống thật hay chơi;
- lực đánh trung bình ở từng bước của từng tiếng (chỗ nhấn, chỗ nhẹ) và độ lệch nhịp trung bình (trống "trễ" hay "sớm"
  một chút so với lưới), để tiếng trống có cảm giác người chơi chứ không đều như máy;
- vài mẫu dồn trống (fill) từ các bản "fill", dùng ở ô cuối mỗi câu nhạc.

Tập test (cột split của info.csv, chia theo tay trống) chỉ dùng để báo độ phủ: bao nhiêu ô nhịp chưa từng thấy vẫn khớp
gần (lệch tối đa 2 nốt) với một mẫu đã học.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import sys
import zipfile
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

import numpy as np
import pretty_midi

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from registry import require_trainable  # noqa: E402

STEPS = 16
LANES = ["kick", "snare", "hihat-close", "hihat-open", "tom-low", "tom-mid", "tom-high", "crash"]
# Bảng nốt của Groove MIDI (bộ Roland TD-11) gom về các tiếng app có. Ride đánh như hi-hat đóng.
NOTE_LANE = {
    36: "kick",
    38: "snare", 40: "snare", 37: "snare",
    42: "hihat-close", 22: "hihat-close", 44: "hihat-close", 51: "hihat-close", 59: "hihat-close", 53: "hihat-close",
    46: "hihat-open", 26: "hihat-open",
    43: "tom-low", 58: "tom-low", 41: "tom-low",
    45: "tom-mid", 47: "tom-mid",
    48: "tom-high", 50: "tom-high",
    49: "crash", 55: "crash", 57: "crash", 52: "crash",
}
PATTERN_LANES = ["kick", "snare", "hihat-close", "hihat-open"]
FILL_LANES = ["kick", "snare", "tom-low", "tom-mid", "tom-high", "crash"]

# Kiểu trống của app → phong cách Groove; ballad chỉ lấy bản chậm.
TARGETS: dict[str, dict] = {
    "pop": {"styles": {"pop", "rock", "country"}, "bpm": (80, 140)},
    "ballad": {"styles": {"soul", "gospel", "blues", "rock", "pop", "country"}, "bpm": (0, 92)},
    "lofi": {"styles": {"hiphop"}, "bpm": (0, 200)},
    "dance": {"styles": {"dance", "funk", "afrobeat"}, "bpm": (90, 200)},
}
TOP_PATTERNS = 10
TOP_FILLS = 6


def read_info(z: zipfile.ZipFile) -> list[dict]:
    name = next(n for n in z.namelist() if n.endswith("info.csv"))
    prefix = name[: -len("info.csv")]
    rows = list(csv.DictReader(io.StringIO(z.read(name).decode("utf-8"))))
    for r in rows:
        r["zip_path"] = prefix + r["midi_filename"]
    return rows


GHOST = 0.3  # lực dưới mức này là nốt lướt (ghost note): không đưa vào mẫu chính, chỉ góp vào phần "cảm giác"


def hits_of(pm: pretty_midi.PrettyMIDI, bpm: float) -> list[tuple[int, str, float, float]]:
    """Mọi nốt trống: (bước tuyệt đối, tiếng, lực 0..1, lệch so với lưới tính theo phần bước)."""
    step_sec = 60.0 / bpm / 4
    out = []
    for inst in pm.instruments:
        for n in inst.notes:
            if n.pitch in NOTE_LANE:
                pos = n.start / step_sec
                out.append((int(round(pos)), NOTE_LANE[n.pitch], n.velocity / 127, pos - round(pos)))
    return sorted(out)


def phase_of(hits: list[tuple[int, str, float, float]]) -> int:
    """File có thể không bắt đầu đúng phách 1. Chọn độ lệch (theo phách) để snare rơi vào phách 2 và 4, kick vào phách 1."""
    snare = Counter(s % STEPS for s, lane, v, _ in hits if lane == "snare" and v >= GHOST)
    kick = Counter(s % STEPS for s, lane, v, _ in hits if lane in ("kick", "crash") and v >= GHOST)
    return max((0, 4, 8, 12), key=lambda p: (snare[(4 + p) % STEPS] + snare[(12 + p) % STEPS], kick[p]))


def bars_of(pm: pretty_midi.PrettyMIDI, bpm: float, keep_last: bool = False) -> list[dict[str, list[tuple[int, float, float]]]]:
    """Mỗi ô: tiếng → danh sách (bước trong ô, lực, lệch). Ô đầu bị cắt bởi độ lệch pha và ô quá thưa bị bỏ."""
    hits = hits_of(pm, bpm)
    if not hits:
        return []
    p = phase_of(hits)
    n_bars = (hits[-1][0] - p) // STEPS + 1
    bars: list[dict[str, list]] = [defaultdict(list) for _ in range(max(0, n_bars))]
    for step, lane, v, o in hits:
        bar, s = divmod(step - p, STEPS)
        if bar < 0 or bar >= n_bars:
            continue
        lst = bars[bar][lane]
        same = next((i for i, x in enumerate(lst) if x[0] == s), None)
        if same is not None:  # hai nốt cùng bước cùng tiếng: giữ nốt mạnh hơn
            if lst[same][1] >= v:
                continue
            lst.pop(same)
        lst.append((s, v, o))
    if not keep_last:
        bars = bars[:-1]  # ô cuối thường bị cắt dở
    return [b for b in bars if sum(len(v) for v in b.values()) >= 3]


def core_key(bars: list[dict], lanes: list[str], min_share: float = 0.5) -> tuple[int, ...]:
    """Mẫu chính của một bản: bước nào có nốt chắc (không phải ghost) ở từ một nửa số ô trở lên."""
    out = []
    for lane in lanes:
        cnt = Counter(s for b in bars for s, v, _ in b.get(lane, []) if v >= GHOST)
        out.append(sum(1 << s for s, c in cnt.items() if c >= min_share * len(bars)))
    return tuple(out)


def key_of(bar: dict, lanes: list[str]) -> tuple[int, ...]:
    out = []
    for lane in lanes:
        mask = 0
        for s, v, _ in bar.get(lane, []):
            if v >= GHOST:
                mask |= 1 << s
        out.append(mask)
    return tuple(out)


def hamming(a: tuple[int, ...], b: tuple[int, ...]) -> int:
    return sum(bin(x ^ y).count("1") for x, y in zip(a, b))


def to_steps(mask: int) -> list[int]:
    return [s for s in range(STEPS) if mask >> s & 1]


def collect(rows: list[dict], z: zipfile.ZipFile, beat_type: str, split: set[str]) -> dict[str, list[list[dict]]]:
    """Kiểu trống của app → danh sách bản (mỗi bản là danh sách ô)."""
    out: dict[str, list[list[dict]]] = defaultdict(list)
    for r in rows:
        if r["beat_type"] != beat_type or r["time_signature"] != "4-4" or r["split"] not in split:
            continue
        style, bpm = r["style"].split("/")[0].split("-")[0], float(r["bpm"])
        targets = [t for t, cfg in TARGETS.items() if style in cfg["styles"] and cfg["bpm"][0] <= bpm < cfg["bpm"][1]]
        if not targets:
            continue
        try:
            pm = pretty_midi.PrettyMIDI(io.BytesIO(z.read(r["zip_path"])))
        except (KeyError, OSError, ValueError):
            continue
        bars = bars_of(pm, bpm, keep_last=beat_type == "fill")
        if bars:
            for t in targets:
                out[t].append(bars)
    return out


def feel(bars: list[dict]) -> dict:
    """Lực đánh và độ lệch trung bình theo từng tiếng, từng bước."""
    vel = {lane: [[] for _ in range(STEPS)] for lane in LANES}
    off = {lane: [[] for _ in range(STEPS)] for lane in LANES}
    for b in bars:
        for lane, hits in b.items():
            for s, v, o in hits:
                vel[lane][s].append(v)
                off[lane][s].append(o)
    res = {}
    for lane in LANES:
        n = [len(x) for x in vel[lane]]
        if sum(n) < 20:
            continue
        mean_v = [round(float(np.mean(x)), 3) if len(x) >= 3 else None for x in vel[lane]]
        mean_o = [round(float(np.clip(np.mean(x), -0.3, 0.3)), 3) if len(x) >= 3 else None for x in off[lane]]
        std_v = float(np.mean([np.std(x) for x in vel[lane] if len(x) >= 3] or [0.08]))
        res[lane] = {"vel": mean_v, "offset": mean_o, "velStd": round(std_v, 3)}
    return res


def pattern_dict(key: tuple[int, ...], lanes: list[str], weight: float) -> dict:
    return {"weight": round(weight, 4), "hits": sum(bin(m).count("1") for m in key), **{lane: to_steps(m) for lane, m in zip(lanes, key) if m}}


def top_patterns(files: list[list[dict]], k: int) -> list[dict]:
    """Mỗi bản góp mẫu chính của nó (mỗi bản một phiếu, bản dài không lấn bản ngắn); gộp mẫu trùng, giữ k mẫu
    nhiều phiếu nhất. Chỉ nhận mẫu có kick ở phách 1 và snare ở phách 2 hoặc 4 (bản lệch pha hoặc nhịp lạ thì bỏ)."""
    w: Counter = Counter()
    for bars in files:
        key = core_key(bars, PATTERN_LANES)
        if key[0] & 1 and key[1] & (1 << 4 | 1 << 12):
            w[key] += 1
    total = sum(w.values()) or 1
    return [pattern_dict(key, PATTERN_LANES, n / total) for key, n in w.most_common(k)]


def top_fills(files: list[list[dict]], k: int) -> list[dict]:
    """Ô dồn trống: trong mỗi bản fill lấy ô có nhiều snare/tom nhất."""
    toms = ("snare", "tom-low", "tom-mid", "tom-high")
    w: Counter = Counter()
    for bars in files:
        best = max(bars, key=lambda b: sum(1 for lane in toms for _, v, _ in b.get(lane, []) if v >= GHOST))
        key = key_of(best, FILL_LANES)
        if sum(bin(key[i]).count("1") for i in range(1, 5)) >= 4:
            w[key] += 1
    total = sum(w.values()) or 1
    return [pattern_dict(key, FILL_LANES, n / total) for key, n in w.most_common(k)]


def coverage(patterns: list[dict], files: list[list[dict]]) -> float:
    """Phần bản trong tập test có mẫu chính lệch tối đa 2 nốt so với một mẫu đã học."""
    keys = [tuple(sum(1 << s for s in p.get(lane, [])) for lane in PATTERN_LANES) for p in patterns]
    if not files or not keys:
        return 0.0
    near = sum(1 for bars in files if min(hamming(core_key(bars, PATTERN_LANES), k) for k in keys) <= 2)
    return near / len(files)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--zip", type=Path, required=True)
    ap.add_argument("--out", type=Path, default=Path("frontend/src/core/grooveModel.json"))
    args = ap.parse_args(argv)

    require_trainable("groove_midi")
    z = zipfile.ZipFile(args.zip)
    rows = read_info(z)
    train = collect(rows, z, "beat", {"train", "validation"})
    test = collect(rows, z, "beat", {"test"})
    fills = collect(rows, z, "fill", {"train", "validation"})

    styles = {}
    report = []
    for t in TARGETS:
        files = train.get(t, [])
        n_bars = sum(len(b) for b in files)
        if len(files) < 10:
            report.append(f"{t}: chỉ có {len(files)} bản, bỏ qua (giữ mẫu viết tay)")
            continue
        pats = top_patterns(files, TOP_PATTERNS)
        fill_pats = top_fills(fills.get(t, []), TOP_FILLS)
        styles[t] = {"files": len(files), "bars": n_bars, "patterns": pats, "fills": fill_pats, "feel": feel([b for f in files for b in f])}
        cov = coverage(pats, test.get(t, []))
        report.append(
            f"{t}: {len(files)} bản ({n_bars} ô), {len(pats)} mẫu, {len(fill_pats)} fill; "
            f"bản tập test có mẫu chính gần một mẫu đã học: {100 * cov:.0f}% ({len(test.get(t, []))} bản)"
        )

    model = {
        "version": 1,
        "source": "Groove MIDI Dataset v1.0.0 (Magenta, CC BY 4.0), học bằng ml/drums/train_groove.py",
        "trained": date.today().isoformat(),
        "steps": STEPS,
        "styles": styles,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(model, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("\n".join(report))
    print(f"Đã ghi {args.out} ({args.out.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
