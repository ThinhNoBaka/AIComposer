import numpy as np
import pytest

from app.humming.evaluate import note_scores
from app.humming.keys import detect_key, snap_to_scale
from app.humming.notes import segment_notes
from app.humming.pipeline import TranscribeOptions, transcribe_array, transcribe_bytes
from app.humming.pitch import track_pitch
from app.humming.quantize import estimate_bpm, quantize
from app.humming.synth import synth_hum, synth_hum_natural, to_wav_bytes

SR = 16000


def melody_seconds(pitches, bpm=100, beats=None, start=0.3, gap=0.06):
    """Dựng nốt tham chiếu: mỗi nốt dài `beats[i]` phách, có khoảng nghỉ nhỏ giữa các nốt (như người ngân)."""
    beat = 60 / bpm
    beats = beats or [1] * len(pitches)
    out, t = [], start
    for p, b in zip(pitches, beats):
        out.append((t, t + b * beat - gap, p))
        t += b * beat
    return out


# "Kìa con bướm vàng" dạng đơn giản, Đô trưởng
TUNE = [60, 62, 64, 60, 60, 62, 64, 60, 64, 65, 67, 64, 65, 67]
TUNE_BEATS = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1, 2]


def test_pitch_tracking_on_steady_tone():
    y = synth_hum([(0.2, 1.2, 69)], SR, vibrato_cents=0)
    tr = track_pitch(y, SR)
    voiced = tr.midi[(tr.times > 0.4) & (tr.times < 1.0)]
    assert np.nanmedian(voiced) == pytest.approx(69, abs=0.2)


@pytest.mark.parametrize("seed", [0, 1, 2])
def test_transcription_f1_on_synthetic_humming(seed):
    ref = melody_seconds(TUNE, 100, TUNE_BEATS)
    y = synth_hum(ref, SR, vibrato_cents=30, noise=0.01, seed=seed)
    notes = segment_notes(track_pitch(y, SR))
    scores = note_scores(ref, notes)
    assert scores["f1"] >= 0.85, scores


def test_repeated_same_pitch_notes_are_split():
    ref = melody_seconds([67, 67, 67, 67], 90, gap=0.08)
    y = synth_hum(ref, SR, seed=3)
    notes = segment_notes(track_pitch(y, SR))
    assert len(notes) == 4


def test_detuned_singer_still_lands_in_key():
    ref = melody_seconds(TUNE, 100, TUNE_BEATS)
    # người ngân lệch 35 cent và cao hơn một quãng tám
    y = synth_hum([(a, b, p + 12) for a, b, p in ref], SR, detune_cents=35, seed=4)
    res = transcribe_array(y, SR, TranscribeOptions(bpm=100))
    assert (res["tonic"], res["mode"]) == (0, "major")
    pcs = [m["pitch"] % 12 for m in res["melody"]]
    assert pcs == [p % 12 for p in TUNE]
    # đưa về khoảng giai điệu của web
    assert all(55 <= m["pitch"] <= 84 for m in res["melody"])


def test_quantized_rhythm_matches_beats():
    ref = melody_seconds(TUNE, 100, TUNE_BEATS)
    res = transcribe_array(synth_hum(ref, SR, seed=5), SR, TranscribeOptions(bpm=100))
    starts = [m["start"] for m in res["melody"]]
    expected = list(np.cumsum([0] + [b * 4 for b in TUNE_BEATS[:-1]]))
    assert starts == expected
    assert res["bars"] == 4


@pytest.mark.parametrize("bpm", [72, 92, 110, 128])
def test_bpm_estimate_close(bpm):
    ref = melody_seconds(TUNE, bpm, TUNE_BEATS)
    notes = segment_notes(track_pitch(synth_hum(ref, SR, seed=6), SR))
    assert abs(estimate_bpm(notes) - bpm) <= 3


def test_silence_and_noise_give_no_notes():
    silent = np.zeros(SR * 2, dtype=np.float32)
    assert transcribe_array(silent, SR)["melody"] == []
    noise = (0.05 * np.random.default_rng(0).standard_normal(SR * 2)).astype(np.float32)
    assert len(transcribe_array(noise, SR)["melody"]) <= 2


def test_wav_bytes_roundtrip_through_decoder():
    ref = melody_seconds([60, 64, 67], 100)
    res = transcribe_bytes(to_wav_bytes(synth_hum(ref, SR, seed=7)), TranscribeOptions(bpm=100))
    assert [m["pitch"] % 12 for m in res["melody"]] == [0, 4, 7]


def test_browser_webm_opus_is_decoded():
    # Trình duyệt ghi âm ra WebM/Opus: phải giải mã được bằng ffmpeg (hệ thống hoặc gói imageio-ffmpeg).
    import subprocess

    from app.humming.audio import ffmpeg_exe

    exe = ffmpeg_exe()
    assert exe, "cần ffmpeg để đọc file ghi âm từ trình duyệt"
    ref = melody_seconds([62, 66, 69], 100)
    wav = to_wav_bytes(synth_hum(ref, SR, seed=8))
    webm = subprocess.run([exe, "-v", "error", "-i", "pipe:0", "-c:a", "libopus", "-f", "webm", "pipe:1"], input=wav, capture_output=True, check=True).stdout
    res = transcribe_bytes(webm, TranscribeOptions(bpm=100))
    assert [m["pitch"] % 12 for m in res["melody"]] == [2, 6, 9]


def test_key_detection_profiles():
    a_minor = [57, 59, 60, 62, 64, 65, 67, 69, 69, 64, 60, 57]
    assert detect_key(a_minor, [1] * len(a_minor))[:2] == (9, "minor")
    g_major = [67, 69, 71, 72, 74, 76, 78, 79, 74, 71, 67]
    assert detect_key(g_major, [1] * len(g_major))[:2] == (7, "major")


def test_snap_to_scale_matches_web_rules():
    assert snap_to_scale(61, 0, "major") == 60
    assert snap_to_scale(70, 0, "major") == 69
    assert snap_to_scale(61, 4, "minorPentatonic") == 62


def test_quantize_resolves_overlaps():
    from app.humming.notes import NoteEvent

    notes = [NoteEvent(0.0, 0.7, 60), NoteEvent(0.6, 1.0, 62), NoteEvent(0.61, 0.65, 64)]
    q = quantize(notes, 120)
    for a, b in zip(q, q[1:]):
        assert a["start"] + a["dur"] <= b["start"]


def test_scores_perfect_and_empty():
    ref = melody_seconds([60, 62, 64], 100)
    assert note_scores(ref, ref)["f1"] == 1.0
    assert note_scores(ref, [])["f1"] == 0.0


@pytest.mark.parametrize("tuning,drift,seed", [(45, -60, 0), (-40, -50, 1), (20, 40, 2), (-48, 0, 3)])
def test_off_tune_legato_humming_keeps_intervals(tuning, drift, seed):
    """Người ngân lệch chuẩn ~một phần tư cung, trôi dần và luyến liền: các quãng giữa nốt vẫn phải đúng."""
    ref = melody_seconds(TUNE, 100, TUNE_BEATS, gap=0.0)
    y = synth_hum_natural(ref, SR, tuning_cents=tuning, drift_cents=drift, seed=seed)
    res = transcribe_array(y, SR, TranscribeOptions(bpm=100))
    got = [m["pitch"] for m in res["melody"]]
    assert len(got) == len(TUNE), got
    shift = got[0] - TUNE[0]
    wrong = sum(g - shift != t for g, t in zip(got, TUNE))
    assert wrong <= 1, (got, res["tuning_cents"])


def test_semitone_step_sung_legato_is_split():
    """Mi→Fa luyến liền (bước nửa cung, không nghỉ) phải ra hai nốt, không gộp thành một."""
    ref = melody_seconds([64, 65, 64, 65], 90, gap=0.0)
    y = synth_hum_natural(ref, SR, tuning_cents=30, drift_cents=0, seed=7)
    notes = segment_notes(track_pitch(y, SR))
    assert len(notes) == 4, [(round(n.onset, 2), round(n.pitch, 2)) for n in notes]
