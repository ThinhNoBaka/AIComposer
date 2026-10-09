// Mở file MIDI thành bài: lấy track giai điệu, tempo, dò giọng, hợp âm theo từng ô và lời (nếu có).
// Mở lại được file do chính app xuất (track "Giai điệu", "Hợp âm", lời dạng sự kiện lyric).

import { Midi } from '@tonejs/midi'
import { melodyPhrases } from './lyrics'
import { MAX_BARS, STEPS_PER_BAR, newId, type Note, type Song } from './song'
import { harmonize } from './suggest'
import { NO_CHORD, chordPcs, type Chord, type Mode } from './theory'

// Hồ sơ Krumhansl–Kessler, giống backend/app/humming/keys.py.
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

function corr(a: number[], b: number[]): number {
  const ma = a.reduce((s, x) => s + x, 0) / a.length
  const mb = b.reduce((s, x) => s + x, 0) / b.length
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb)
    da += (a[i] - ma) ** 2
    db += (b[i] - mb) ** 2
  }
  return da && db ? num / Math.sqrt(da * db) : -1
}

/** Dò giọng từ biểu đồ 12 nốt (trọng số = trường độ). */
export function detectKey(hist: number[]): { tonic: number; mode: 'major' | 'minor' } {
  let best = { tonic: 0, mode: 'major' as 'major' | 'minor', r: -2 }
  for (let t = 0; t < 12; t++) {
    for (const [mode, prof] of [
      ['major', MAJOR],
      ['minor', MINOR],
    ] as const) {
      const rot = prof.map((_, i) => prof[(i - t + 12) % 12])
      const r = corr(hist, rot)
      if (r > best.r) best = { tonic: t, mode, r }
    }
  }
  return { tonic: best.tonic, mode: best.mode }
}

type RawNote = { midi: number; ticks: number; durationTicks: number; velocity: number }

/** Lấy một nốt mỗi lúc (nốt cao nhất) để track nhiều bè vẫn ra một đường giai điệu. */
function monophonic(notes: Note[]): Note[] {
  const byStart = new Map<number, Note>()
  for (const n of notes) {
    const cur = byStart.get(n.start)
    if (!cur || n.pitch > cur.pitch) byStart.set(n.start, n)
  }
  const out = [...byStart.values()].sort((a, b) => a.start - b.start)
  for (let i = 0; i + 1 < out.length; i++) out[i] = { ...out[i], dur: Math.max(1, Math.min(out[i].dur, out[i + 1].start - out[i].start)) }
  return out
}

/** Điểm chọn track giai điệu: nhiều nốt, ở tầm cao, ít nốt chồng nhau. Track tên "Giai điệu"/"Melody" ưu tiên tuyệt đối. */
function melodyScore(name: string, notes: RawNote[]): number {
  if (/giai\s*điệu|melody|vocal|lead/i.test(decodeText(name))) return 1e9
  if (!notes.length) return -1
  const avg = notes.reduce((s, n) => s + n.midi, 0) / notes.length
  const starts = new Set(notes.map((n) => n.ticks)).size
  const mono = starts / notes.length
  return starts * mono * Math.max(0.1, (avg - 40) / 30)
}

function decodeText(t: string): string {
  // File do app xuất ghi lời dạng byte UTF-8; file karaoke cũ có thể là Latin-1. Thử UTF-8 trước.
  if (![...t].every((c) => c.charCodeAt(0) < 256)) return t
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from([...t].map((c) => c.charCodeAt(0))))
  } catch {
    return t
  }
}

export type ImportResult = { song: Song; melodyTrack: string; hasChords: boolean; hasLyrics: boolean }

export function midiToSong(data: ArrayBuffer | Uint8Array, base: Song, fileName = ''): ImportResult {
  const midi = new Midi(data)
  const ppq = midi.header.ppq || 480
  const ticksPerStep = ppq / 4
  const bpm = Math.round(Math.min(180, Math.max(50, midi.header.tempos[0]?.bpm ?? base.bpm)))
  const toStep = (ticks: number) => Math.round(ticks / ticksPerStep)

  const tracks = midi.tracks.filter((t) => t.channel !== 9 && t.notes.length)
  if (!tracks.length) throw new Error('File MIDI không có nốt nào (ngoài trống).')
  const melTrack = tracks.reduce((a, b) => (melodyScore(b.name, b.notes) > melodyScore(a.name, a.notes) ? b : a))
  const raw: Note[] = melTrack.notes.map((n) => ({
    id: newId(),
    pitch: n.midi,
    start: toStep(n.ticks),
    dur: Math.max(1, toStep(n.ticks + n.durationTicks) - toStep(n.ticks)),
    vel: Math.max(1, Math.min(127, Math.round(n.velocity * 127))),
  }))
  // Bắt đầu từ ô có nốt đầu tiên (bỏ ô trống đầu file), giới hạn MAX_BARS.
  const firstBar = Math.floor(Math.min(...raw.map((n) => n.start)) / STEPS_PER_BAR)
  const offset = firstBar * STEPS_PER_BAR
  const limit = MAX_BARS * STEPS_PER_BAR
  const shifted = raw.map((n) => ({ ...n, start: n.start - offset })).filter((n) => n.start < limit)
  // Track có tên giai điệu (vd. file do app xuất) giữ nguyên mọi nốt; track đoán ra thì chỉ lấy một nốt mỗi lúc.
  const named = /giai\s*điệu|melody|vocal|lead/i.test(decodeText(melTrack.name))
  const melody = named ? shifted.sort((a, b) => a.start - b.start) : monophonic(shifted)
  const end = Math.max(...melody.map((n) => n.start + n.dur))
  const bars = Math.min(MAX_BARS, Math.max(4, Math.ceil(end / STEPS_PER_BAR / 4) * 4))

  // Giọng: tính trên mọi track không phải trống (hợp âm giúp dò chính xác hơn giai điệu một mình).
  const hist = new Array(12).fill(0)
  for (const t of tracks) for (const n of t.notes) hist[n.midi % 12] += n.durationTicks
  const { tonic, mode } = detectKey(hist)

  // Hợp âm: từ track tên "Hợp âm"/"Chord", hoặc track khác có nhiều nốt chồng nhau nhất.
  const others = tracks.filter((t) => t !== melTrack)
  const poly = (t: (typeof tracks)[number]) => t.notes.length / Math.max(1, new Set(t.notes.map((n) => n.ticks)).size)
  const chordTrack =
    others.find((t) => /hợp\s*âm|chord|piano|guitar|pad/i.test(decodeText(t.name))) ?? others.filter((t) => poly(t) >= 2).sort((a, b) => poly(b) - poly(a))[0]
  let song: Song = {
    ...base,
    title: decodeText(midi.header.name ?? '').trim() || fileName.replace(/\.(mid|midi|kar)$/i, '') || base.title,
    tonic,
    mode: mode as Mode,
    bpm,
    bars,
    melody,
    chords: Array.from({ length: bars }, () => ({ ...NO_CHORD })),
    fx: [],
    sections: undefined,
    lyrics: undefined,
  }
  if (chordTrack) {
    const chords: Chord[] = []
    for (let bar = 0; bar < bars; bar++) {
      const w = new Array(12).fill(0)
      for (const n of chordTrack.notes) {
        const s = toStep(n.ticks) - offset
        const e = toStep(n.ticks + n.durationTicks) - offset
        const ov = Math.min(e, (bar + 1) * STEPS_PER_BAR) - Math.max(s, bar * STEPS_PER_BAR)
        if (ov > 0) w[n.midi % 12] += ov
      }
      if (!w.some((x) => x > 0)) {
        chords.push({ ...NO_CHORD })
        continue
      }
      let best = 0
      let bestScore = -Infinity
      for (let d = 0; d < 7; d++) {
        const pcs = chordPcs({ degree: d, seventh: false }, tonic, mode)
        const score = pcs.reduce((s, pc, i) => s + w[pc] * (i === 0 ? 1.2 : 1), 0) - 0.3 * w.reduce((s, x, pc) => s + (pcs.includes(pc) ? 0 : x), 0)
        if (score > bestScore) {
          bestScore = score
          best = d
        }
      }
      const pcs7 = chordPcs({ degree: best, seventh: true }, tonic, mode)
      chords.push({ degree: best, seventh: w[pcs7[3]] > 0.25 * Math.max(...w) })
    }
    song = { ...song, chords }
  } else {
    song = { ...song, chords: harmonize(song) }
  }

  // Lời: sự kiện lyric/text gắn với nốt cùng thời điểm; mỗi câu nhạc (theo khoảng nghỉ) là một dòng.
  const words = midi.header.meta
    .filter((m) => m.type === 'lyrics' || m.type === 'text')
    .map((m) => ({ step: toStep(m.ticks) - offset, text: decodeText(m.text).replace(/[\\/\r\n]+/g, ' ').trim() }))
    .filter((w) => w.text && !/^@/.test(w.text))
  let hasLyrics = false
  if (words.length >= 2) {
    const phrases = melodyPhrases(melody)
    const lines = phrases.map(() => [] as string[])
    for (const w of words) {
      const i = phrases.findIndex((ph) => ph.some((n) => n.start === w.step))
      if (i >= 0) lines[i].push(w.text)
    }
    const text = lines.filter((l) => l.length).map((l) => l.join(' ')).join('\n')
    if (text) {
      song = { ...song, lyrics: text }
      hasLyrics = true
    }
  }
  return { song, melodyTrack: decodeText(melTrack.name) || 'không tên', hasChords: !!chordTrack, hasLyrics }
}
