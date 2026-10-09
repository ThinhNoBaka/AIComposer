"""Tải bộ dữ liệu POP909 (909 bài pop Trung Quốc, có chú thích hợp âm, giọng, phách).

Mỗi bài lấy 4 file: <NNN>.mid, chord_midi.txt, key_audio.txt, beat_midi.txt,
lưu vào ml/harmony/data/raw/<NNN>/. File đã có thì bỏ qua.

    python ml/harmony/fetch_pop909.py              # cả 909 bài
    python ml/harmony/fetch_pop909.py --limit 50   # 50 bài đầu
"""

from __future__ import annotations

import argparse
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

BASE = "https://raw.githubusercontent.com/music-x-lab/POP909-Dataset/master/POP909"
ANNOTATIONS = ("chord_midi.txt", "key_audio.txt", "beat_midi.txt")
N_SONGS = 909
HERE = Path(__file__).resolve().parent
DEFAULT_OUT = HERE / "data" / "raw"


def song_files(song_id: str) -> list[str]:
    return [f"{song_id}.mid", *ANNOTATIONS]


def download(url: str, dest: Path, retries: int = 3) -> bool:
    """Tải một file. Trả False nếu file không tồn tại (404)."""
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                data = r.read()
            tmp = dest.with_suffix(dest.suffix + ".part")
            tmp.write_bytes(data)
            tmp.replace(dest)
            return True
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return False
            err: Exception = e
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            err = e
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"Không tải được {url}: {err}")


def fetch_song(song_id: str, out: Path) -> tuple[str, int, list[str]]:
    """Tải các file còn thiếu của một bài. Trả (id, số file mới tải, danh sách file không có)."""
    folder = out / song_id
    folder.mkdir(parents=True, exist_ok=True)
    fresh = 0
    missing: list[str] = []
    for name in song_files(song_id):
        dest = folder / name
        if dest.exists() and dest.stat().st_size > 0:
            continue
        if download(f"{BASE}/{song_id}/{name}", dest):
            fresh += 1
        else:
            missing.append(name)
    return song_id, fresh, missing


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--limit", type=int, default=N_SONGS, help="số bài tải (tính từ 001)")
    ap.add_argument("--workers", type=int, default=16, help="số luồng tải song song")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args(argv)

    ids = [f"{i:03d}" for i in range(1, min(args.limit, N_SONGS) + 1)]
    args.out.mkdir(parents=True, exist_ok=True)
    total_new = 0
    failed: list[str] = []
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = {ex.submit(fetch_song, sid, args.out): sid for sid in ids}
        for i, fut in enumerate(as_completed(futures), 1):
            sid = futures[fut]
            try:
                _, fresh, missing = fut.result()
                total_new += fresh
                if missing:
                    print(f"  {sid}: thiếu {', '.join(missing)}", file=sys.stderr)
            except Exception as e:  # noqa: BLE001 - ghi lại rồi tải tiếp bài khác
                failed.append(sid)
                print(f"  {sid}: lỗi {e}", file=sys.stderr)
            if i % 100 == 0 or i == len(ids):
                print(f"{i}/{len(ids)} bài, {total_new} file mới")
    if failed:
        print(f"Lỗi {len(failed)} bài: {' '.join(failed)}", file=sys.stderr)
    return 1 if failed and len(failed) == len(ids) else 0


if __name__ == "__main__":
    sys.exit(main())
