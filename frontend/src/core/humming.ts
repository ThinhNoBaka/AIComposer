// Đưa kết quả nhận nốt từ bản ngân nga vào bài: đổi giọng/tempo nếu cần, đặt giai điệu,
// rồi tự hoà âm để thành một bài có hợp âm, bass, trống ngay.

import { getMood, progressionToChords } from './moods'
import { STEPS_PER_BAR, newId, type Note, type Song } from './song'
import { harmonize } from './suggest'
import { snapToScale, type Mode } from './theory'

export const MAX_BARS = 16

export type HummedMelody = {
  bpm: number
  tonic: number
  mode: string
  bars: number
  melody: { pitch: number; start: number; dur: number; vel: number }[]
}

export type ApplyOptions = { useKey: boolean; useBpm: boolean; autoHarmony: boolean }

export function applyHumming(song: Song, hum: HummedMelody, opts: ApplyOptions): { song: Song; dropped: number } {
  const mood = getMood(song.moodId)
  const useKey = opts.useKey && (hum.mode === 'major' || hum.mode === 'minor')
  const tonic = useKey ? hum.tonic : song.tonic
  const mode: Mode = useKey ? (hum.mode as Mode) : song.mode
  const bpm = opts.useBpm ? Math.round(Math.min(180, Math.max(50, hum.bpm))) : song.bpm
  // Làm tròn số ô lên bội của 4 (một câu nhạc), tối thiểu 4, tối đa MAX_BARS.
  const bars = Math.min(MAX_BARS, Math.max(4, Math.ceil(hum.bars / 4) * 4))
  const limit = bars * STEPS_PER_BAR
  let dropped = 0
  const melody: Note[] = []
  for (const n of hum.melody) {
    if (n.start >= limit) {
      dropped++
      continue
    }
    melody.push({
      id: newId(),
      // Giọng giữ nguyên thì đưa nốt vào thang hiện tại để piano roll khoá thang vẫn đúng.
      pitch: useKey ? n.pitch : snapToScale(n.pitch, tonic, mode),
      start: n.start,
      dur: Math.max(1, Math.min(n.dur, limit - n.start)),
      vel: Math.max(1, Math.min(127, n.vel)),
    })
  }
  const sevenths = song.chords[0]?.seventh ?? mood.sevenths
  let next: Song = {
    ...song,
    tonic,
    mode,
    bpm,
    bars,
    chords: progressionToChords(mood.progressions[0], bars, sevenths),
    melody,
    fx: song.fx.filter((f) => f.start < limit),
  }
  if (opts.autoHarmony && melody.length) next = { ...next, chords: harmonize(next) }
  return { song: next, dropped }
}

/** Đổi độ dài bài: thêm ô thì lặp lại vòng hợp âm đang có, bớt ô thì cắt giai điệu và hiệu ứng phía sau. */
export function resizeSong(song: Song, bars: number): Song {
  const n = Math.min(MAX_BARS, Math.max(1, Math.round(bars)))
  if (n === song.bars) return song
  const limit = n * STEPS_PER_BAR
  const src = song.chords.length ? song.chords : [{ degree: 0, seventh: false }]
  return {
    ...song,
    bars: n,
    chords: Array.from({ length: n }, (_, i) => ({ ...src[i % src.length] })),
    melody: song.melody.filter((x) => x.start < limit).map((x) => ({ ...x, dur: Math.min(x.dur, limit - x.start) })),
    fx: song.fx.filter((f) => f.start < limit),
  }
}
