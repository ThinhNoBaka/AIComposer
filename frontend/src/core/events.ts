// Trải phẳng bài nhạc thành danh sách sự kiện để phát, render WAV và xuất MIDI dùng chung.

import { bassNotes, chordTrackNotes, drumHits, type DrumSound } from './accompany'
import type { Song, TrackId } from './song'

export type PlayEvent =
  | { kind: 'note'; track: Exclude<TrackId, 'drums'>; pitch: number; start: number; dur: number; vel: number }
  | { kind: 'drum'; track: 'drums'; sound: DrumSound; start: number; vel: number }
  | { kind: 'fx'; track: 'fx'; fx: string; start: number }

/** Lệch nhịp swing: các nốt nằm ở nửa sau của phách bị đẩy trễ. Trả về vị trí (bước, có thể lẻ). */
export function applySwing(step: number, swing: number): number {
  if (swing <= 0) return step
  const inBeat = step % 4
  if (inBeat === 2) return step + swing * 2
  if (inBeat === 1 || inBeat === 3) return step + swing
  return step
}

export function buildEvents(song: Song): PlayEvent[] {
  const ev: PlayEvent[] = []
  const sw = (s: number) => applySwing(s, song.swing)
  if (!song.tracks.melody.muted) {
    for (const n of song.melody) ev.push({ kind: 'note', track: 'melody', pitch: n.pitch, start: sw(n.start), dur: n.dur, vel: n.vel })
  }
  if (!song.tracks.chords.muted) {
    for (const n of chordTrackNotes(song)) ev.push({ kind: 'note', track: 'chords', ...n, start: sw(n.start) })
  }
  if (!song.tracks.bass.muted) {
    for (const n of bassNotes(song)) ev.push({ kind: 'note', track: 'bass', ...n, start: sw(n.start) })
  }
  if (!song.tracks.drums.muted) {
    for (const h of drumHits(song)) ev.push({ kind: 'drum', track: 'drums', ...h, start: sw(h.start) })
  }
  for (const f of song.fx) ev.push({ kind: 'fx', track: 'fx', fx: f.fx, start: f.start })
  return ev.sort((a, b) => a.start - b.start)
}
