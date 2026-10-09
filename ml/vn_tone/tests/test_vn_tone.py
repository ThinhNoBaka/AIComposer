"""Chạy thử đường ống thanh điệu → giai điệu trên dữ liệu giả lập: tạo .kar/.mid (mido) và MusicXML (music21),
trích bảng chữ, học bảng xác suất, kiểm tra JSON xuất cho frontend."""

import json
import random
import sys
import unicodedata
from pathlib import Path

import numpy as np
import pytest

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

import extract_audio  # noqa: E402
import extract_symbolic  # noqa: E402
import vn_common  # noqa: E402


def _load(name: str, path: Path):
    """Nạp theo đường dẫn với tên riêng: ml/harmony cũng có train.py, import "train" sẽ lẫn."""
    import importlib.util

    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


train = _load("vn_tone_train", HERE / "train.py")

mido = pytest.importorskip("mido")

TPB = 480
HEIGHT = {"sac": 2, "nga": 2, "ngang": 1, "hoi": 0, "huyen": 0, "nang": 0}
WORDS = "em anh ta đi về nhớ thương mưa rơi trên phố nhỏ chiều xa xưa lá vàng gió mây đã cũ mãi nặng người hỏi những ngày".split()


def cp1258_bytes(text: str) -> bytes:
    """Mã hoá cp1258 kiểu Windows tiếng Việt: chữ có mũ/móc dựng sẵn, dấu thanh là ký tự tổ hợp riêng."""
    out = ""
    for ch in unicodedata.normalize("NFC", text):
        d = unicodedata.normalize("NFD", ch)
        tone = "".join(c for c in d if c in vn_common.MARK_TONE)
        out += unicodedata.normalize("NFC", "".join(c for c in d if c not in vn_common.MARK_TONE)) + tone
    return out.encode("cp1258")


_VNI_ENCODE = {"Việt": "Vieät", "Nam": "Nam", "đường": "ñöôøng", "người": "ngöôøi", "tiếng": "tieáng", "chúng": "chuùng", "ta": "ta", "hát": "haùt", "mãi": "maõi", "nhỏ": "nhoû"}


def tune_for(lines: list[list[str]], seed: int) -> list[list[int]]:
    """Cao độ đi theo thanh điệu (như người viết nhạc Việt hay làm), có chút ngẫu nhiên."""
    rng = random.Random(seed)
    out = []
    for words in lines:
        p, prev, ps = 64, None, []
        for w in words:
            t = vn_common.tone_of(w)
            if prev is not None:
                d = HEIGHT[t] - HEIGHT[prev]
                p += (rng.choice([2, 3, 4]) if d > 0 else -rng.choice([1, 2, 3]) if d < 0 else rng.choice([-1, 0, 0, 1])) if rng.random() > 0.1 else rng.choice([-2, 2])
            ps.append(p)
            prev = t
        out.append(ps)
    return out


def write_mid(path: Path, lines: list[list[str]], pitches: list[list[int]], mode: str, encode, melisma_at=(0, 2)):
    """mode 'kar': lời là text event ở track riêng, đầu câu có '/'. mode 'lyrics': meta lyrics trong track giai điệu.
    Chữ ở vị trí melisma_at (câu, chữ) ngân qua 2 nốt. Có thêm track hợp âm và trống để thử chọn đúng track giai điệu."""
    mf = mido.MidiFile(ticks_per_beat=TPB, charset="latin-1")
    meta = mido.MidiTrack()
    meta.append(mido.MetaMessage("set_tempo", tempo=600000, time=0))
    mf.tracks.append(meta)
    mel, words_tr = mido.MidiTrack(), mido.MidiTrack()
    events: list[tuple[int, object]] = []  # (tick, msg) cho track giai điệu
    lyr: list[tuple[int, str]] = []
    tick = 0
    for li, (ws, ps) in enumerate(zip(lines, pitches)):
        for wi, (w, p) in enumerate(zip(ws, ps)):
            text = ("/" if wi == 0 else " ") + w if mode == "kar" else w + " "
            lyr.append((tick, text))
            if (li, wi) == melisma_at:
                for k, q in enumerate((p, p + 2)):
                    events += [(tick + k * TPB // 2, mido.Message("note_on", note=q, velocity=90)), (tick + (k + 1) * TPB // 2 - 10, mido.Message("note_off", note=q))]
            else:
                events += [(tick, mido.Message("note_on", note=p, velocity=90)), (tick + TPB - 10, mido.Message("note_off", note=p))]
            tick += TPB
        tick += 2 * TPB  # nghỉ giữa câu
    if mode == "lyrics":
        events += [(t, mido.MetaMessage("lyrics", text=encode(s).decode("latin-1"))) for t, s in lyr]
    else:
        words_tr.append(mido.MetaMessage("text", text="@TBai thu", time=0))
        last = 0
        for t, s in lyr:
            words_tr.append(mido.MetaMessage("text", text=encode(s).decode("latin-1"), time=t - last))
            last = t
    events.sort(key=lambda e: (e[0], e[1].type == "note_on"))
    last = 0
    for t, m in events:
        mel.append(m.copy(time=t - last))
        last = t
    mf.tracks.append(mel)
    if mode == "kar":
        mf.tracks.append(words_tr)
    acc = mido.MidiTrack()  # hợp âm trên kênh 1, nốt thấp và không trùng nhịp chữ
    for bar in range(tick // (4 * TPB)):
        for k, n in enumerate((48, 52, 55)):
            acc.append(mido.Message("note_on", channel=1, note=n, velocity=60, time=TPB // 2 if k == 0 else 0))
        for k, n in enumerate((48, 52, 55)):
            acc.append(mido.Message("note_off", channel=1, note=n, time=3 * TPB if k == 0 else 0))
        acc.append(mido.Message("note_on", channel=9, note=36, velocity=100, time=0))
        acc.append(mido.Message("note_off", channel=9, note=36, time=TPB // 2))
    mf.tracks.append(acc)
    path.parent.mkdir(parents=True, exist_ok=True)
    mf.save(str(path))


def random_lines(seed: int, n_lines=4, n_words=6) -> list[list[str]]:
    rng = random.Random(seed)
    return [[rng.choice(WORDS) for _ in range(n_words)] for _ in range(n_lines)]


# ---------- Đơn vị ----------


def test_tone_rule_matches_frontend():
    assert [vn_common.tone_of(w) for w in ["ma", "mà", "má", "mả", "mã", "mạ"]] == ["ngang", "huyen", "sac", "hoi", "nga", "nang"]
    assert vn_common.tone_of(unicodedata.normalize("NFD", "người")) == "huyen"
    assert vn_common.tone_of("Thương,") == "ngang"
    assert vn_common.bare_word("Em,") == "em"


def test_decode_utf8_cp1258_vni():
    text = "Việt Nam ơi người hỏi ngã nặng"
    assert vn_common.decode_vietnamese(text.encode()) == (text, "utf-8")
    assert vn_common.decode_vietnamese(cp1258_bytes(text)) == (text, "cp1258")
    vni = " ".join(_VNI_ENCODE.values()).encode("cp1252")
    assert vn_common.decode_vietnamese(vni) == (" ".join(_VNI_ENCODE), "vni")
    assert vn_common.decode_vietnamese(b"la la") == ("la la", "utf-8")


def test_karaoke_fragments_join_and_lines():
    frags = [(0, "/Em"), (480, " ơi"), (960, " ng"), (960, "ười"), (1440, "\\Hà"), (1920, " Nội\r"), (2400, "phố")]
    s = extract_symbolic._syllables_from_fragments(frags)
    assert [x["syllable"] for x in s] == ["Em", "ơi", "người", "Hà", "Nội", "phố"]
    assert [x["new_line"] for x in s] == [True, False, False, True, False, True]


# ---------- Đầu đến cuối ----------


@pytest.fixture
def corpus(tmp_path):
    raw = tmp_path / "raw"
    songs = {}
    encs = {"utf-8": lambda s: s.encode("utf-8"), "cp1258": cp1258_bytes}
    specs = [
        ("tac_gia_a/bai_1.kar", "kar", "cp1258"),
        ("tac_gia_a/bai_2.mid", "lyrics", "utf-8"),
        ("tac_gia_b/bai_3.kar", "kar", "utf-8"),
        ("tac_gia_b/bai_4.mid", "lyrics", "cp1258"),
        ("tac_gia_c/bai_5.kar", "kar", "utf-8"),
        ("tac_gia_c/bai_6.mid", "lyrics", "utf-8"),
    ]
    for i, (rel, mode, enc) in enumerate(specs):
        lines = random_lines(i)
        pitches = tune_for(lines, i)
        write_mid(raw / rel, lines, pitches, mode, encs[enc])
        songs[rel] = (lines, pitches, enc)
    # Một bài gõ bằng VNI (bảng mã cũ hay gặp trong file .kar).
    vni_lines = [["Việt", "Nam", "người", "tiếng", "hát"], ["chúng", "ta", "mãi", "nhỏ", "đường"]]
    vni_p = tune_for(vni_lines, 99)
    write_mid(raw / "tac_gia_d/vni.kar", vni_lines, vni_p, "kar", _vni)
    songs["tac_gia_d/vni.kar"] = (vni_lines, vni_p, "vni")
    return raw, songs


def _vni(s: str) -> bytes:
    prefix = s[0] if s[0] in "/ " else ""
    return (prefix + _VNI_ENCODE[s[len(prefix):]]).encode("cp1252")


def test_extract_then_train(tmp_path, corpus):
    raw, songs = corpus
    out = tmp_path / "processed"
    assert extract_symbolic.main(["--input", str(raw), "--out", str(out)]) == 0
    rows = vn_common.read_rows(out)
    manifest = {r["song_id"]: r for r in __import__("csv").DictReader((out / "manifest.csv").open(encoding="utf-8"))}
    assert len(manifest) == len(songs)

    for rel, (lines, pitches, enc) in songs.items():
        sid = vn_common.slug(str(Path(rel).with_suffix("")))
        assert manifest[sid]["status"] == "ok", manifest[sid]
        assert manifest[sid]["encoding"] == enc
        got = sorted((r for r in rows if r["song_id"] == sid), key=lambda r: (r["line"], r["idx_in_line"]))
        assert [r["syllable"] for r in got] == [vn_common.bare_word(w) for ws in lines for w in ws]
        assert [r["tone"] for r in got] == [vn_common.tone_of(w) for ws in lines for w in ws]
        assert [r["pitch"] for r in got] == [p for ps in pitches for p in ps]
        assert max(r["line"] for r in got) == len(lines) - 1
        assert all((r["interval_prev"] is None) == (r["idx_in_line"] == 0) for r in got)
        assert got[0]["artist_id"] == Path(rel).parts[0]
        if enc != "vni":
            assert got[2]["melisma_notes"] == 2 and got[2]["dur_beat"] == pytest.approx(1 - 10 / TPB, abs=1e-3)
            assert sum(r["melisma_notes"] for r in got) == len(got) + 1
        assert got[1]["onset_beat"] == pytest.approx(1.0)
        assert set(vn_common.SCHEMA) <= set(got[0])

    model_path = tmp_path / "tone_model.json"
    assert train.main(["--data", str(out), "--out", str(model_path)]) == 0
    m = json.loads(model_path.read_text(encoding="utf-8"))
    assert m["version"] == 1 and m["n"] > 0
    assert [b["name"] for b in m["buckets"]] == [b["name"] for b in train.BUCKETS]
    assert len(m["table"]) == 36
    for key, probs in m["table"].items():
        a, b = key.split("|")
        assert a in vn_common.TONES and b in vn_common.TONES
        assert len(probs) == 7 and sum(probs) == pytest.approx(1, abs=1e-3) and min(probs) > 0
        assert sum(m["direction"][key]) == pytest.approx(1, abs=1e-3)
    # Dữ liệu giả lập đi theo thanh: ngang → sắc phải hay đi lên hơn đi xuống.
    down, _, up = m["direction"]["ngang|sac"]
    assert up > down
    assert "dir_acc_pair" in m["metrics"]


def test_musicxml(tmp_path):
    music21 = pytest.importorskip("music21")
    from music21 import note, stream, tie

    part = stream.Part()
    spec = [("Em", 64, 1), ("về", 62, 1), ("nhớ", 67, 0.5), (None, 69, 0.5), ("mãi", 69, 1), ("rest", 0, 2), ("ngày", 60, 1), ("xưa", 62, 1)]
    for w, p, d in spec:
        if w == "rest":
            part.append(note.Rest(quarterLength=d))
            continue
        n = note.Note(p, quarterLength=d)
        if w:
            n.lyric = w
        part.append(n)
    # Nốt nối (tie) không tính là nốt ngân mới.
    n1, n2 = note.Note(64, quarterLength=1), note.Note(64, quarterLength=1)
    n1.lyric = "đi"
    n1.tie, n2.tie = tie.Tie("start"), tie.Tie("stop")
    part.append([n1, n2])
    s = stream.Score([part])
    path = tmp_path / "raw" / "tac_gia_x" / "bai.musicxml"
    path.parent.mkdir(parents=True)
    s.write("musicxml", fp=str(path))
    rows, info = extract_symbolic.extract_file(path, tmp_path / "raw", {})
    assert info["status"] == "ok"
    assert [r["syllable"] for r in rows] == ["em", "về", "nhớ", "mãi", "ngày", "xưa", "đi"]
    assert [r["line"] for r in rows] == [0, 0, 0, 0, 1, 1, 1]
    assert rows[2]["melisma_notes"] == 2 and rows[2]["dur_beat"] == pytest.approx(1)
    assert rows[6]["melisma_notes"] == 1 and rows[6]["dur_beat"] == pytest.approx(2)
    assert rows[1]["interval_prev"] == -2 and rows[1]["tone"] == "huyen"
    assert music21 is not None


# ---------- Các hàm thuần của đường audio ----------


def test_parse_lrc_and_txt():
    lrc = "[ar:Ai đó]\n[00:12.50]Em ơi Hà Nội phố\n[00:20.00][01:10.00]ta còn em\n\n"
    got = extract_audio.parse_lyrics(lrc)
    assert [t for t, _ in got] == [12.5, 20.0, 70.0]
    assert got[0][1] == ["Em", "ơi", "Hà", "Nội", "phố"]
    assert extract_audio.parse_lyrics("một hai\nba")[1] == (None, ["ba"])


def test_notes_from_f0():
    times = np.arange(200) * 0.01
    midi = np.full(200, np.nan)
    midi[10:60] = 60 + 0.1 * np.sin(np.arange(50))
    midi[60:110] = 64.0
    midi[130:190] = 62.0
    notes = extract_audio.notes_from_f0(times, midi)
    assert [round(p) for _, _, p in notes] == [60, 64, 62]
    assert notes[0][0] == pytest.approx(0.10) and notes[2][1] == pytest.approx(1.90)


def test_ctc_alignment_and_matching():
    vocab = {"<pad>": 0, "|": 1, "e": 2, "m": 3, "ơ": 4, "i": 5}
    words = ["Em", "ơi"]
    tokens, owner = extract_audio.words_to_tokens(words, vocab)
    assert tokens == [2, 3, 1, 4, 5] and owner == [0, 0, -1, 1, 1]
    # Ma trận giả: mỗi token "sáng" ở đúng các khung định sẵn, còn lại là blank.
    plan = {5: 2, 6: 2, 7: 3, 8: 3, 12: 1, 20: 4, 21: 4, 22: 5, 23: 5}
    lp = np.full((30, len(vocab)), np.log(0.01))
    for t in range(30):
        lp[t, plan.get(t, 0)] = np.log(0.95)
    spans = extract_audio.ctc_align(lp, tokens, 0)
    assert spans == [(5, 6), (7, 8), (12, 12), (20, 21), (22, 23)]
    aligned = extract_audio.align_with_log_probs(lp, 0.02, words, vocab, 0, offset=1.0)
    assert [(i, w) for i, w, _, _ in aligned] == [(0, "Em"), (1, "ơi")]
    assert aligned[0][2] == pytest.approx(1.10) and aligned[1][3] == pytest.approx(1.48)
    notes = [(1.10, 1.30, 64.2), (1.30, 1.38, 66.0), (1.40, 1.60, 62.0)]
    sylls = extract_audio.match_words_to_notes([[(w, s, e) for _, w, s, e in aligned]], notes, bpm=120)
    assert [(s["syllable"], s["pitch"], s["melisma_notes"]) for s in sylls] == [("Em", 64, 2), ("ơi", 62, 1)]
    rows = vn_common.finish_rows(sylls, "bai", "x", "audio", (0, "major"))
    assert rows[1]["interval_prev"] == -2 and rows[0]["onset_beat"] == pytest.approx(2.2)
