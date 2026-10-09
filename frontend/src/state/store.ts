// Trạng thái bài nhạc có lịch sử undo/redo. Các thao tác liên tục (kéo nốt, kéo thanh trượt)
// gộp thành một bước lịch sử nhờ `coalesce`.

import { useEffect, useReducer } from 'react'
import { getMood, songFromMood } from '../core/moods'
import { remapMelody } from '../core/melody'
import { validateSong, type Song } from '../core/song'

const STORAGE_KEY = 'aicomposer.song.v1'
const HISTORY_LIMIT = 100

export type History = { past: Song[]; present: Song; future: Song[]; lastKey: string | null; lastAt: number }

export type Action =
  | { type: 'update'; patch: (s: Song) => Song; coalesce?: string }
  | { type: 'mood'; moodId: string }
  | { type: 'load'; song: Song }
  | { type: 'undo' }
  | { type: 'redo' }

/** Đổi mood: lấy preset mới (key, tempo, hợp âm, nhạc cụ), giữ giai điệu và chuyển nó sang thang mới. */
export function applyMood(song: Song, moodId: string): Song {
  const mood = getMood(moodId)
  const fresh = songFromMood(mood, song.bars)
  return {
    ...fresh,
    title: song.title,
    seed: song.seed,
    fx: song.fx,
    fxVolume: song.fxVolume,
    melody: remapMelody(song.melody, song, fresh),
    // Bài đã hoàn thiện: giữ cấu trúc và vòng hợp âm (bậc hợp âm vẫn đúng ở giọng mới).
    ...(song.sections ? { sections: song.sections, chords: song.chords } : {}),
  }
}

export function reducer(h: History, a: Action): History {
  const now = Date.now()
  const commit = (next: Song, key: string | null): History => {
    if (next === h.present) return h
    const merge = key !== null && key === h.lastKey && now - h.lastAt < 1500
    return {
      past: merge ? h.past : [...h.past, h.present].slice(-HISTORY_LIMIT),
      present: next,
      future: [],
      lastKey: key,
      lastAt: now,
    }
  }
  switch (a.type) {
    case 'update':
      return commit(a.patch(h.present), a.coalesce ?? null)
    case 'mood':
      return commit(applyMood(h.present, a.moodId), null)
    case 'load':
      return commit(a.song, null)
    case 'undo': {
      const prev = h.past.at(-1)
      if (!prev) return h
      return { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future], lastKey: null, lastAt: 0 }
    }
    case 'redo': {
      const next = h.future[0]
      if (!next) return h
      return { past: [...h.past, h.present], present: next, future: h.future.slice(1), lastKey: null, lastAt: 0 }
    }
  }
}

function loadSaved(): Song | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const s = JSON.parse(raw)
    return validateSong(s) === null ? (s as Song) : null
  } catch {
    return null
  }
}

export function initialHistory(): History {
  const present = loadSaved() ?? songFromMood(getMood('vui'))
  return { past: [], present, future: [], lastKey: null, lastAt: 0 }
}

export function useSongStore() {
  const [history, dispatch] = useReducer(reducer, undefined, initialHistory)
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(history.present))
      } catch {
        // Trình duyệt chặn lưu (chế độ ẩn danh...): bỏ qua, bài vẫn dùng được trong phiên này.
      }
    }, 400)
    return () => clearTimeout(t)
  }, [history.present])
  return { history, dispatch }
}
