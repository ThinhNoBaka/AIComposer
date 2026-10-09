// Đệm tự động: hợp âm (block / nhịp / rải / quạt chả), bass và trống, suy ra từ vòng hợp âm.

import { GROOVE_SOUNDS, feelHit, grooveStyle, pickFill, pickPattern, stableJitter, type GrooveStyle } from './grooveModel'
import { STEPS_PER_BAR, chordStyleAt, densityAt, drumStyleAt, sectionAt, stepSeconds, type Song } from './song'
import { chordPitches, isNoChord } from './theory'

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
    if (!base.length) {
      voicings.push([])
      continue
    }
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

/** Nhịp quạt chả theo móc đơn (8 ô mỗi ô nhịp): D = quạt xuống, U = quạt lên, '-' = nghỉ. */
export const STRUM_PATTERNS: Record<0 | 1 | 2, string> = {
  0: 'D---D---',
  1: 'D-DU-UDU',
  2: 'DUDUDUDU',
}

/** Khoảng cách giữa hai dây khi quạt (ms): quạt xuống chậm hơn quạt lên một chút. */
const STRUM_DOWN_MS = 20
const STRUM_UP_MS = 14

/**
 * Quạt chả kiểu guitar: các nốt của hợp âm vang lệch nhau vài chục ms.
 * Quạt xuống từ dây trầm lên dây cao (thêm nốt gốc thấp một quãng tám nếu còn trong tầm guitar),
 * quạt lên từ dây cao xuống, chỉ 3 dây trên và nhẹ hơn. Vị trí là bước có phần lẻ.
 */
export function strumBar(v: number[], t0: number, density: 0 | 1 | 2, bpm: number): AccNote[] {
  const out: AccNote[] = []
  if (!v.length) return out
  const pattern = STRUM_PATTERNS[density]
  const stepSec = stepSeconds(bpm)
  const down = v[0] - 12 >= 40 ? [v[0] - 12, ...v] : v
  const up = [...v].reverse().slice(0, 3)
  for (let slot = 0; slot < pattern.length; slot++) {
    const kind = pattern[slot]
    if (kind === '-') continue
    let next = slot + 1
    while (next < pattern.length && pattern[next] === '-') next++
    const span = (next - slot) * 2
    const strings = kind === 'D' ? down : up
    const gap = (kind === 'D' ? STRUM_DOWN_MS : STRUM_UP_MS) / 1000 / stepSec
    const accent = slot % 4 === 0
    strings.forEach((p, i) => {
      const off = i * gap
      out.push({
        pitch: p,
        start: t0 + slot * 2 + off,
        dur: Math.max(0.25, span - off - 0.1),
        vel: kind === 'D' ? (accent ? 84 : 74) - i * 2 : 56 - i * 3,
      })
    })
  }
  return out
}

export function chordTrackNotes(song: Song): AccNote[] {
  const out: AccNote[] = []
  const voicings = voiceChords(song)
  voicings.forEach((v, bar) => {
    if (!v.length) return
    const t0 = bar * STEPS_PER_BAR
    const density = densityAt(song, bar)
    const style = chordStyleAt(song, bar)
    if (sectionAt(song, bar)?.kind === 'outro') {
      // Phần kết: hợp âm ngân dài, không nhịp.
      v.forEach((p) => out.push({ pitch: p, start: t0, dur: 16, vel: 70 }))
      return
    }
    if (style === 'strum') {
      out.push(...strumBar(v, t0, density, song.bpm))
    } else if (style === 'block') {
      if (density === 2) {
        for (const s of [0, 8]) v.forEach((p) => out.push({ pitch: p, start: t0 + s, dur: 8, vel: s === 0 ? 80 : 66 }))
      } else {
        v.forEach((p) => out.push({ pitch: p, start: t0, dur: 16, vel: 76 }))
      }
    } else if (style === 'pulse') {
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
    if (isNoChord(song.chords[bar])) continue
    const t0 = bar * STEPS_PER_BAR
    const root = bassRoot(song, bar)
    const triad = chordPitches(song.chords[bar], song.tonic, song.mode, 2)
    const fifth = root + (triad[2] - triad[0])
    const density = densityAt(song, bar)
    if (drumStyleAt(song, bar) === 'dance' && density > 0) {
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
    const style = drumStyleAt(song, bar)
    // Dạo đầu không trống; phần kết chỉ còn một tiếng cymbal + kick mở đầu.
    if (section?.kind === 'intro') continue
    if (section?.kind === 'outro') {
      if (local === 0 && style !== 'none') {
        add(bar, 'kick', [0], 110)
        add(bar, 'crash', [0], 100)
      }
      continue
    }
    // Vào điệp khúc luôn có cymbal.
    if (section?.kind === 'chorus' && local === 0 && (style === 'ballad' || style === 'lofi')) add(bar, 'crash', [0], 95)
    const g = song.drumFeel !== 'basic' ? grooveStyle(style) : null
    if (g) {
      grooveBar(out, g, song, bar, section?.start ?? Math.floor(bar / 8) * 8, d, phraseStart, phraseEnd)
      continue
    }
    switch (style) {
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

/**
 * Một ô trống theo mẫu tay trống thật (Groove MIDI): mỗi đoạn (hoặc mỗi 8 ô) một mẫu, ô cuối câu thay nửa sau bằng
 * mẫu dồn trống, lực và độ lệch nhịp theo cảm giác đã học.
 */
function grooveBar(out: DrumHit[], g: GrooveStyle, song: Song, bar: number, unit: number, d: 0 | 1 | 2, phraseStart: boolean, phraseEnd: boolean) {
  const seed = (song.drumSeed ?? song.seed) >>> 0
  const pat = pickPattern(g, d, seed + unit * 31)
  const fill = phraseEnd && d > 0 ? pickFill(g, seed + bar * 13) : null
  const t0 = bar * STEPS_PER_BAR
  const hit = (sound: DrumSound, s: number, lane: number, fallback: number) => {
    const { vel, offset } = feelHit(g, sound, s, fallback, stableJitter(seed, bar, s, lane))
    // Không kéo nốt sang ô trước (ô trước có thể là dạo đầu không trống).
    out.push({ sound, start: Math.max(t0, t0 + s + offset), vel })
  }
  GROOVE_SOUNDS.forEach((sound, lane) => {
    let steps = pat[sound] ?? []
    if (fill) steps = [...steps.filter((s) => s < 8), ...(fill[sound] ?? []).filter((s) => s >= 8)]
    for (const s of steps) hit(sound, s, lane, sound === 'kick' ? 105 : sound === 'snare' ? 95 : 70)
  })
  // Mẫu chỉ có kick + snare (tay trống dùng ride lúc có lúc không): thêm hi-hat móc đơn nhẹ cho đỡ trống trải.
  if (d > 0 && !pat['hihat-close'] && !pat['hihat-open']) for (let s = 0; s < 16; s += 2) hit('hihat-close', s, 9, 62)
  if (phraseStart && d > 0 && bar > 0 && !pat.crash) hit('crash', 0, 10, 90)
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
