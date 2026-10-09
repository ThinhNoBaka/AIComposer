// Đệm tự động: hợp âm (block / nhịp / rải), bass và trống, suy ra từ vòng hợp âm.

import { STEPS_PER_BAR, densityAt, sectionAt, type Song } from './song'
import { chordPitches } from './theory'

export type AccNote = { pitch: number; start: number; dur: number; vel: number }

export type DrumSound =
  | 'kick'
  | 'snare'
  | 'clap'
  | 'hihat-close'
  | 'hihat-open'
  | 'tom-low'
  | 'tom-mid'
  | 'tom-high'
  | 'crash'

export type DrumHit = { sound: DrumSound; start: number; vel: number }

/** Chọn thế bấm (đảo hợp âm) gần thế trước nhất để hợp âm chuyển mượt. */
export function voiceChords(song: Song): number[][] {
  const voicings: number[][] = []
  let prev: number[] | null = null
  for (const chord of song.chords) {
    const base = chordPitches(chord, song.tonic, song.mode, 3)
    const cands: number[][] = []
    for (let inv = 0; inv < base.length; inv++) {
      const v = base.map((p, i) => (i < inv ? p + 12 : p)).sort((a, b) => a - b)
      for (const shift of [-12, 0, 12]) {
        const s = v.map((p) => p + shift)
        if (s[0] >= 48 && s[s.length - 1] <= 76) cands.push(s)
      }
    }
    const pool = cands.length ? cands : [base]
    let best = pool[0]
    let bestCost = Infinity
    for (const c of pool) {
      const mean = c.reduce((a, b) => a + b, 0) / c.length
      const cost = prev
        ? c.reduce((acc, p, i) => acc + Math.abs(p - (prev as number[])[Math.min(i, (prev as number[]).length - 1)]), 0)
        : Math.abs(mean - 60)
      if (cost < bestCost) {
        bestCost = cost
        best = c
      }
    }
    voicings.push(best)
    prev = best
  }
  return voicings
}

export function chordTrackNotes(song: Song): AccNote[] {
  const out: AccNote[] = []
  const voicings = voiceChords(song)
  voicings.forEach((v, bar) => {
    const t0 = bar * STEPS_PER_BAR
    const density = densityAt(song, bar)
    if (sectionAt(song, bar)?.kind === 'outro') {
      // Phần kết: hợp âm ngân dài, không nhịp.
      v.forEach((p) => out.push({ pitch: p, start: t0, dur: 16, vel: 70 }))
      return
    }
    if (song.chordStyle === 'block') {
      if (density === 2) {
        for (const s of [0, 8]) v.forEach((p) => out.push({ pitch: p, start: t0 + s, dur: 8, vel: s === 0 ? 80 : 66 }))
      } else {
        v.forEach((p) => out.push({ pitch: p, start: t0, dur: 16, vel: 76 }))
      }
    } else if (song.chordStyle === 'pulse') {
      const every = density === 0 ? 8 : density === 1 ? 4 : 2
      for (let s = 0; s < STEPS_PER_BAR; s += every) {
        const accent = s % 8 === 0
        v.forEach((p) => out.push({ pitch: p, start: t0 + s, dur: Math.max(1, every - 1), vel: accent ? 82 : 66 }))
      }
    } else {
      // Rải hợp âm: lên rồi xuống.
      const tones = density === 2 ? [...v, v[0] + 12] : v
      const order = [...tones.keys(), ...[...tones.keys()].reverse().slice(1, -1)]
      const every = density === 0 ? 4 : 2
      let k = 0
      for (let s = 0; s < STEPS_PER_BAR; s += every) {
        const p = tones[order[k % order.length]]
        out.push({ pitch: p, start: t0 + s, dur: every * 2, vel: s % 8 === 0 ? 78 : 64 })
        k += 1
      }
    }
  })
  return out
}

function bassRoot(song: Song, bar: number): number {
  const root = chordPitches(song.chords[bar], song.tonic, song.mode, 2)[0]
  // Đưa nốt gốc vào khoảng E1..D#2 (MIDI 28..39) để bass không quá cao hay đục.
  let p = root
  while (p > 39) p -= 12
  while (p < 28) p += 12
  return p
}

export function bassNotes(song: Song): AccNote[] {
  const out: AccNote[] = []
  for (let bar = 0; bar < song.bars; bar++) {
    const t0 = bar * STEPS_PER_BAR
    const root = bassRoot(song, bar)
    const triad = chordPitches(song.chords[bar], song.tonic, song.mode, 2)
    const fifth = root + (triad[2] - triad[0])
    const density = densityAt(song, bar)
    if (song.drumStyle === 'dance' && density > 0) {
      for (const s of [2, 6, 10, 14]) out.push({ pitch: root, start: t0 + s, dur: 2, vel: 96 })
      if (density === 2) for (const s of [0, 8]) out.push({ pitch: root, start: t0 + s, dur: 1, vel: 70 })
    } else if (density === 0) {
      out.push({ pitch: root, start: t0, dur: 16, vel: 92 })
    } else if (density === 1) {
      out.push({ pitch: root, start: t0, dur: 7, vel: 96 })
      out.push({ pitch: root, start: t0 + 8, dur: 5, vel: 84 })
      out.push({ pitch: fifth, start: t0 + 14, dur: 2, vel: 76 })
    } else {
      const seq = [root, root, fifth, root, root + 12, root, fifth, root]
      seq.forEach((p, i) => out.push({ pitch: p, start: t0 + i * 2, dur: 2, vel: i % 2 === 0 ? 94 : 76 }))
    }
  }
  return out
}

export function drumHits(song: Song): DrumHit[] {
  const out: DrumHit[] = []
  const add = (bar: number, sound: DrumSound, steps: number[], vel: number) => {
    for (const s of steps) out.push({ sound, start: bar * STEPS_PER_BAR + s, vel })
  }
  for (let bar = 0; bar < song.bars; bar++) {
    const section = sectionAt(song, bar)
    const d = densityAt(song, bar)
    const local = section ? bar - section.start : bar
    const phraseStart = local % 4 === 0
    const phraseEnd = local % 4 === 3 || (!!section && local === section.bars - 1)
    // Dạo đầu không trống; phần kết chỉ còn một tiếng cymbal + kick mở đầu.
    if (section?.kind === 'intro') continue
    if (section?.kind === 'outro') {
      if (local === 0 && song.drumStyle !== 'none') {
        add(bar, 'kick', [0], 110)
        add(bar, 'crash', [0], 100)
      }
      continue
    }
    // Vào điệp khúc luôn có cymbal.
    if (section?.kind === 'chorus' && local === 0 && (song.drumStyle === 'ballad' || song.drumStyle === 'lofi')) add(bar, 'crash', [0], 95)
    switch (song.drumStyle) {
      case 'pop':
        add(bar, 'kick', d === 2 ? [0, 8, 10] : [0, 8], 110)
        add(bar, 'snare', phraseEnd && d > 0 ? [4, 12, 13, 14, 15] : [4, 12], 100)
        add(bar, 'hihat-close', d === 0 ? [0, 4, 8, 12] : [0, 2, 4, 6, 8, 10, 12, 14], 70)
        if (phraseStart && d > 0 && bar > 0) add(bar, 'crash', [0], 90)
        break
      case 'ballad':
        add(bar, 'kick', d === 2 ? [0, 6, 10] : [0, 10], 100)
        add(bar, 'snare', [8], 90)
        add(bar, 'hihat-close', d === 2 ? [0, 2, 4, 6, 8, 10, 12, 14] : [0, 4, 8, 12], 60)
        break
      case 'lofi':
        add(bar, 'kick', [0, 7, 10], 100)
        add(bar, 'snare', [4, 12], 85)
        add(bar, 'hihat-close', [0, 4, 8, 12], 62)
        if (d > 0) add(bar, 'hihat-close', [2, 6, 10, 14], 40)
        break
      case 'dance':
        add(bar, 'kick', [0, 4, 8, 12], 118)
        add(bar, 'clap', [4, 12], 100)
        add(bar, 'hihat-open', [2, 6, 10, 14], 72)
        if (d === 2) add(bar, 'hihat-close', [1, 3, 5, 7, 9, 11, 13, 15], 50)
        if (phraseStart && bar > 0) add(bar, 'crash', [0], 95)
        break
      case 'epic':
        add(bar, 'kick', [0, 3, 8], 115)
        add(bar, 'tom-low', [8, 10], 100)
        add(bar, 'tom-mid', [12], 96)
        add(bar, 'tom-high', d > 0 ? [14, 15] : [14], 92)
        add(bar, 'snare', [4], 96)
        if (phraseStart) add(bar, 'crash', [0], 100)
        break
      case 'none':
        break
    }
  }
  return out
}

/** Số nốt trống GM (kênh 10) cho xuất MIDI. */
export const GM_DRUM_NOTE: Record<DrumSound, number> = {
  kick: 36,
  snare: 38,
  clap: 39,
  'hihat-close': 42,
  'hihat-open': 46,
  'tom-low': 45,
  'tom-mid': 47,
  'tom-high': 50,
  crash: 49,
}
