"""Mô hình dò onset (điểm bắt đầu nốt) học từ dữ liệu, chạy bằng numpy thuần (không cần sklearn).

File mô hình là JSON do `ml/humming/train_onset.py` xuất ra. Pipeline gọi
`apply_onset_model(notes, track, y)` sau bước tách nốt:
  - chẻ một nốt dài làm đôi ở chỗ mô hình thấy có onset (nốt lặp lại cùng cao độ, hát liền hơi);
  - gộp hai nốt liền nhau cùng cao độ nếu mô hình thấy không có onset ở giữa (chỗ chỉ hụt hơi).
Không có file mô hình thì trả nguyên danh sách nốt, pipeline chạy y như cũ.

Đặc trưng tính ở đây là nguồn duy nhất: script huấn luyện gọi đúng các hàm này nên lúc học
và lúc chạy luôn khớp nhau.

Đường dẫn: biến môi trường HUMMING_MODEL, mặc định backend/models/humming_onset.json
(trong Docker là /app/models/humming_onset.json). Đặt HUMMING_MODEL=none để tắt.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, fields, replace
from functools import lru_cache
from pathlib import Path

import numpy as np

from .notes import NoteEvent
from .pitch import FRAME, HOP, PitchTrack

log = logging.getLogger(__name__)

DEFAULT_MODEL_PATH = Path(__file__).resolve().parents[2] / "models" / "humming_onset.json"
MODEL_VERSION = 1
SR = 16000

# Đặc trưng gốc cho từng khung 10 ms (trước khi ghép ngữ cảnh các khung lân cận).
BASE_FEATURES = ("f0_cents", "voiced_prob", "delta_f0", "rms_db", "delta_rms_db", "flux", "onset_strength")
SPECTRAL = ("flux", "onset_strength")


# ---------- Đặc trưng ----------


def _fit(x: np.ndarray, n: int) -> np.ndarray:
    """Cắt hoặc đệm (lặp giá trị cuối) cho đúng n khung."""
    x = np.asarray(x, dtype=float)
    if len(x) >= n:
        return x[:n]
    return np.pad(x, (0, n - len(x)), mode="edge") if len(x) else np.zeros(n)


def spectral_features(y: np.ndarray, sr: int, n: int) -> tuple[np.ndarray, np.ndarray]:
    """Spectral flux và onset strength, cùng lưới khung với pYIN (hop 10 ms, khung căn giữa)."""
    import librosa

    y = np.asarray(y, dtype=np.float32)
    mag = np.abs(librosa.stft(y, n_fft=FRAME, hop_length=HOP))
    logmag = np.log1p(10.0 * mag)
    flux = np.concatenate([[0.0], np.maximum(0.0, np.diff(logmag, axis=1)).sum(axis=0)])
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP)
    return _fit(flux, n), _fit(onset_env, n)


def base_features(track: PitchTrack, y: np.ndarray | None = None) -> dict[str, np.ndarray]:
    """Các đặc trưng gốc, mỗi cái một mảng dài bằng số khung. Thiếu audio `y` thì flux/onset = 0."""
    n = len(track.midi)
    midi = np.asarray(track.midi, dtype=float)
    vp = np.nan_to_num(np.asarray(track.voiced_prob, dtype=float))
    voiced = np.isfinite(midi) & (vp >= 0.1)
    # Cao độ tính bằng cent so với trung vị cả bản thu: không phụ thuộc giọng cao hay thấp.
    ref = float(np.median(midi[voiced])) if voiced.any() else 0.0
    cents = np.where(voiced, (np.nan_to_num(midi, nan=ref) - ref) * 100.0, 0.0)
    cents = np.clip(cents, -2400, 2400)
    delta = np.zeros(n)
    if n > 1:
        both = voiced[1:] & voiced[:-1]
        delta[1:] = np.where(both, np.clip(cents[1:] - cents[:-1], -300, 300), 0.0)
    rms = np.asarray(track.rms, dtype=float)
    peak = float(rms.max()) if n and rms.max() > 0 else 1.0
    rms_db = 20.0 * np.log10(rms / peak + 1e-5)
    d_rms = np.concatenate([[0.0], np.diff(rms_db)]) if n else rms_db

    if y is not None and n:
        flux, onset_env = spectral_features(y, track.sr, n)
    else:
        flux, onset_env = np.zeros(n), np.zeros(n)

    def norm(x: np.ndarray) -> np.ndarray:
        m = float(np.max(x)) if len(x) else 0.0
        return x / m if m > 0 else np.zeros(len(x))

    return {
        "f0_cents": cents,
        "voiced_prob": vp,
        "delta_f0": delta,
        "rms_db": rms_db,
        "delta_rms_db": d_rms,
        "flux": norm(flux),
        "onset_strength": norm(onset_env),
    }


def stacked_names(base: list[str] | tuple[str, ...], context: int) -> list[str]:
    return [f"{name}@{off:+d}" for off in range(-context, context + 1) for name in base]


def frame_features(
    track: PitchTrack, y: np.ndarray | None = None, base: list[str] | tuple[str, ...] = BASE_FEATURES, context: int = 3
) -> np.ndarray:
    """Ma trận [số khung, len(base) * (2*context+1)]: đặc trưng của khung và các khung lân cận."""
    n = len(track.midi)
    width = len(base) * (2 * context + 1)
    if n == 0:
        return np.zeros((0, width))
    feats = base_features(track, y if any(b in SPECTRAL for b in base) else None)
    m = np.stack([feats[name] for name in base], axis=1)
    padded = np.pad(m, ((context, context), (0, 0)), mode="edge")
    cols = [padded[context + off : context + off + n] for off in range(-context, context + 1)]
    return np.concatenate(cols, axis=1)


def pick_peaks(prob: np.ndarray, threshold: float, min_gap: int) -> np.ndarray:
    """Khung là onset nếu xác suất vượt ngưỡng và cao nhất trong cửa sổ ±min_gap khung."""
    out: list[int] = []
    taken = np.zeros(len(prob), dtype=bool)
    for i in np.argsort(-prob, kind="stable"):
        if prob[i] < threshold:
            break
        lo, hi = max(0, i - min_gap), min(len(prob), i + min_gap + 1)
        if taken[lo:hi].any():
            continue
        taken[i] = True
        out.append(int(i))
    return np.array(sorted(out), dtype=int)


# ---------- Mô hình ----------

_ACTS = {
    "relu": lambda x: np.maximum(x, 0.0),
    "tanh": np.tanh,
    "sigmoid": lambda x: 1.0 / (1.0 + np.exp(-np.clip(x, -50, 50))),
    "linear": lambda x: x,
}


@dataclass
class OnsetModel:
    base: list[str]
    context: int
    mean: np.ndarray
    std: np.ndarray
    layers: list[tuple[np.ndarray, np.ndarray, str]]
    threshold: float = 0.5
    min_gap_frames: int = 6
    merge_tolerance_frames: int = 4
    path: str = ""

    @classmethod
    def from_dict(cls, d: dict, path: str = "") -> OnsetModel:
        """Đọc và kiểm tra JSON. Sai định dạng thì báo ValueError."""
        if int(d.get("version", 0)) != MODEL_VERSION:
            raise ValueError(f"version {d.get('version')} không hỗ trợ (cần {MODEL_VERSION})")
        if int(d.get("hop_length", HOP)) != HOP or int(d.get("sr", SR)) != SR or int(d.get("frame_length", FRAME)) != FRAME:
            raise ValueError(f"hop_length/sr/frame_length của mô hình khác pipeline (cần {HOP}/{SR}/{FRAME})")
        context = int(d.get("context", 3))
        base = list(d.get("base_features") or BASE_FEATURES)
        unknown = [b for b in base if b not in BASE_FEATURES]
        if unknown:
            raise ValueError(f"đặc trưng lạ: {unknown}")
        names = list(d["feature_names"])
        if names != stacked_names(base, context):
            raise ValueError("feature_names không khớp base_features/context")
        mean = np.asarray(d["mean"], dtype=float)
        std = np.asarray(d["std"], dtype=float)
        if mean.shape != (len(names),) or std.shape != (len(names),):
            raise ValueError("mean/std sai kích thước")
        layers = []
        dim = len(names)
        for layer in d["layers"]:
            w = np.asarray(layer["W"], dtype=float)
            b = np.asarray(layer["b"], dtype=float)
            act = str(layer.get("act", "linear"))
            if act not in _ACTS:
                raise ValueError(f"hàm kích hoạt lạ: {act}")
            if w.ndim != 2 or w.shape[0] != dim or b.shape != (w.shape[1],):
                raise ValueError("kích thước W/b không khớp")
            layers.append((w, b, act))
            dim = w.shape[1]
        if not layers or dim != 1 or layers[-1][2] != "sigmoid":
            raise ValueError("lớp cuối phải ra 1 giá trị với sigmoid")
        return cls(
            base=base,
            context=context,
            mean=mean,
            std=np.where(std > 1e-8, std, 1.0),
            layers=layers,
            threshold=float(d.get("threshold", 0.5)),
            min_gap_frames=int(d.get("min_gap_frames", 6)),
            merge_tolerance_frames=int(d.get("merge_tolerance_frames", 4)),
            path=path,
        )

    @property
    def needs_audio(self) -> bool:
        return any(b in SPECTRAL for b in self.base)

    def predict_matrix(self, x: np.ndarray) -> np.ndarray:
        h = (x - self.mean) / self.std
        for w, b, act in self.layers:
            h = _ACTS[act](h @ w + b)
        return h[:, 0]

    def predict(self, track: PitchTrack, y: np.ndarray | None = None) -> np.ndarray:
        """Xác suất mỗi khung là onset."""
        x = frame_features(track, y, self.base, self.context)
        return self.predict_matrix(x) if len(x) else np.zeros(0)

    def onset_frames(self, track: PitchTrack, y: np.ndarray | None = None) -> np.ndarray:
        return pick_peaks(self.predict(track, y), self.threshold, self.min_gap_frames)


def model_path() -> Path | None:
    raw = os.environ.get("HUMMING_MODEL", "").strip()
    if raw.lower() in {"none", "off", "0", "false"}:
        return None
    return Path(raw) if raw else DEFAULT_MODEL_PATH


@lru_cache(maxsize=4)
def _load(path: str, _mtime_ns: int) -> OnsetModel | None:
    try:
        with open(path, encoding="utf-8") as f:
            model = OnsetModel.from_dict(json.load(f), path)
    except Exception as exc:  # noqa: BLE001 - file hỏng thì quay về cách tách nốt cũ
        log.warning("Bỏ qua mô hình onset %s: %s", path, exc)
        return None
    log.info("Đã nạp mô hình onset %s (%d đặc trưng)", path, len(model.mean))
    return model


def load_model() -> OnsetModel | None:
    """Mô hình onset nếu có file hợp lệ, không thì None. Chỉ đọc file một lần (đọc lại khi file đổi)."""
    path = model_path()
    if path is None:
        return None
    try:
        mtime = path.stat().st_mtime_ns
    except OSError:
        return None
    return _load(str(path), mtime)


# ---------- Áp vào danh sách nốt ----------

MIN_PART_FRAMES = 5  # mỗi mảnh sau khi chẻ dài ít nhất 50 ms
MERGE_GAP_SEC = 0.06  # hai nốt cách nhau ít hơn mức này mới xét gộp
MERGE_PITCH = 0.5  # nửa cung: lệch ít hơn coi là cùng cao độ


def _frame_range(track: PitchTrack, onset: float, offset: float) -> np.ndarray:
    return np.flatnonzero((track.times >= onset - 1e-6) & (track.times < offset - 1e-6))


def _note_from_frames(track: PitchTrack, frames: np.ndarray, like: NoteEvent) -> NoteEvent:
    hop_sec = track.hop / track.sr
    midi = track.midi[frames]
    ok = np.isfinite(midi)
    pitch = float(np.median(midi[ok])) if ok.any() else like.pitch
    values = {
        "onset": float(track.times[frames[0]]),
        "offset": float(track.times[frames[-1]] + hop_sec),
        "pitch": pitch,
        "energy": float(np.mean(track.rms[frames])),
        "frames": [int(i) for i in frames],
    }
    # Chỉ điền các trường NoteEvent đang có (giữ được khi notes.py đổi cấu trúc).
    own = {f.name for f in fields(like)}
    return replace(like, **{k: v for k, v in values.items() if k in own})


def split_merge(notes: list[NoteEvent], track: PitchTrack, onsets: np.ndarray, tolerance: int = 4) -> list[NoteEvent]:
    """Chẻ nốt ở onset nằm giữa nốt; gộp hai nốt liền, cùng cao độ mà không có onset nào gần chỗ nối."""
    onset_set = np.asarray(onsets, dtype=int)
    split: list[NoteEvent] = []
    for n in notes:
        frames = _frame_range(track, n.onset, n.offset)
        if len(frames) < 2 * MIN_PART_FRAMES:
            split.append(n)
            continue
        cuts = [
            int(np.searchsorted(frames, f))
            for f in onset_set
            if frames[0] + MIN_PART_FRAMES <= f <= frames[-1] - MIN_PART_FRAMES + 1
        ]
        if not cuts:
            split.append(n)
            continue
        bounds = [0, *sorted(set(cuts)), len(frames)]
        for a, b in zip(bounds, bounds[1:]):
            if b - a > 0:
                split.append(_note_from_frames(track, frames[a:b], n))

    out: list[NoteEvent] = []
    for n in split:
        if out:
            prev = out[-1]
            gap = n.onset - prev.offset
            start_frame = int(round(n.onset * track.sr / track.hop))
            has_onset = bool(np.any(np.abs(onset_set - start_frame) <= tolerance)) if len(onset_set) else False
            if 0 <= gap < MERGE_GAP_SEC and abs(n.pitch - prev.pitch) < MERGE_PITCH and not has_onset:
                frames = _frame_range(track, prev.onset, n.offset)
                out[-1] = _note_from_frames(track, frames, prev) if len(frames) else prev
                continue
        out.append(n)
    return out


def apply_onset_model(
    notes: list[NoteEvent], track: PitchTrack, y: np.ndarray | None = None, model: OnsetModel | None = None
) -> list[NoteEvent]:
    """Sửa ranh giới nốt theo onset dự đoán. Không có mô hình thì trả nguyên `notes`.

    `y` là audio (16 kHz) đã đưa vào track_pitch; cần cho đặc trưng flux/onset strength.
    """
    model = model or load_model()
    if model is None or not notes or len(track.midi) == 0:
        return notes
    return split_merge(notes, track, model.onset_frames(track, y), model.merge_tolerance_frames)
