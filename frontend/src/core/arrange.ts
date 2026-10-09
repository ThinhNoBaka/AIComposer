// "Biến tấu bản phối": mỗi đoạn một cách đệm (đoạn chính thưa, điệp khúc dày),
// và đổi vòng hợp âm điệp khúc bằng hợp âm thay thế cùng chức năng.

import { createRng } from './rng'
import type { ChordStyle, DrumStyle, SectionKind, SectionStyle, Song } from './song'
import { isNoChord, type Chord } from './theory'

/** Kiểu đệm hợp âm theo độ dày: thưa (ngân, rải) và dày (quạt chả, đánh theo nhịp). */
const SPARSE_CHORDS: ChordStyle[] = ['block', 'arpeggio']
const DENSE_CHORDS: ChordStyle[] = ['strum', 'pulse']

/** Nhịp trống nhẹ hơn / mạnh hơn một bậc, giữ cùng chất nhạc. */
const LIGHTER: Record<DrumStyle, DrumStyle[]> = {
  pop: ['pop', 'ballad'],
  ballad: ['ballad'],
  lofi: ['lofi'],
  dance: ['dance', 'pop'],
  epic: ['epic', 'ballad'],
  none: ['none'],
}
const HEAVIER: Record<DrumStyle, DrumStyle[]> = {
  pop: ['pop', 'dance'],
  ballad: ['ballad', 'pop'],
  lofi: ['lofi'],
  dance: ['dance'],
  epic: ['epic'],
  none: ['none'],
}

/** Hợp âm thay thế cùng chức năng (chung 2 nốt): I ~ vi, iii; IV ~ ii; V ~ iii; vi ~ I, IV; ii ~ IV. */
export const SUBSTITUTES: Record<number, number[]> = {
  0: [5, 2],
  1: [3],
  2: [0, 4],
  3: [1, 5],
  4: [2],
  5: [0, 3],
  6: [4],
}

function pick<T>(r: () => number, xs: T[]): T {
  return xs[Math.floor(r() * xs.length) % xs.length]
}

function styleFor(kind: SectionKind | 'whole', base: SectionStyle, r: () => number): SectionStyle {
  switch (kind) {
    case 'intro':
    case 'outro':
      return { chordStyle: pick(r, SPARSE_CHORDS), drumStyle: base.drumStyle }
    case 'verse':
      return { chordStyle: SPARSE_CHORDS.includes(base.chordStyle) && r() < 0.5 ? base.chordStyle : pick(r, SPARSE_CHORDS), drumStyle: pick(r, LIGHTER[base.drumStyle]) }
    case 'chorus':
      return { chordStyle: pick(r, DENSE_CHORDS), drumStyle: pick(r, HEAVIER[base.drumStyle]) }
    case 'whole': {
      const all: ChordStyle[] = [...SPARSE_CHORDS, ...DENSE_CHORDS].filter((c) => c !== base.chordStyle)
      return { chordStyle: pick(r, all), drumStyle: pick(r, [...new Set([...LIGHTER[base.drumStyle], ...HEAVIER[base.drumStyle]])]) }
    }
  }
}

/** Đổi vòng hợp âm điệp khúc: giữ hợp âm đầu và cuối đoạn (chỗ vào và chỗ kết), thay vài hợp âm giữa. */
export function varyProgression(chords: Chord[], r: () => number): Chord[] {
  const out = chords.map((c) => ({ ...c }))
  const inner = out.map((_, i) => i).filter((i) => i > 0 && i < out.length - 1 && !isNoChord(out[i]))
  let changed = 0
  for (const i of inner) {
    if (r() < 0.5) {
      out[i] = { ...out[i], degree: pick(r, SUBSTITUTES[out[i].degree] ?? [out[i].degree]) }
      changed++
    }
  }
  // Luôn đổi ít nhất một hợp âm để người dùng nghe ra khác.
  if (!changed && inner.length) {
    const i = pick(r, inner)
    out[i] = { ...out[i], degree: pick(r, SUBSTITUTES[out[i].degree] ?? [out[i].degree]) }
  }
  return out
}

export function varyArrangement(song: Song, seed: number): Song {
  const r = createRng(seed).next
  const base: SectionStyle = { chordStyle: song.chordStyle, drumStyle: song.drumStyle }
  if (!song.sections?.length) {
    // Bài chưa chia đoạn: cả bài một cách đệm mới.
    const st = styleFor('whole', base, r)
    return { ...song, chordStyle: st.chordStyle, drumStyle: st.drumStyle, sectionStyles: undefined, drumSeed: seed }
  }
  const sectionStyles: Record<number, SectionStyle> = {}
  // Mọi đoạn cùng loại dùng chung một cách đệm và một vòng hợp âm, để điệp khúc lặp lại vẫn nhận ra.
  const perKind = new Map<SectionKind, SectionStyle>()
  for (const sec of song.sections) {
    let st = perKind.get(sec.kind)
    if (!st) {
      st = styleFor(sec.kind, base, r)
      perKind.set(sec.kind, st)
    }
    sectionStyles[sec.start] = st
  }
  // Đảm bảo điệp khúc dày hơn đoạn chính.
  const verse = perKind.get('verse')
  const chorus = perKind.get('chorus')
  if (verse && chorus && verse.chordStyle === chorus.chordStyle) chorus.chordStyle = 'strum'

  const chords = song.chords.map((c) => ({ ...c }))
  // Khoá hợp âm: chỉ đổi cách đệm, giữ nguyên vòng hợp âm.
  const choruses = song.locks?.chords ? [] : song.sections.filter((x) => x.kind === 'chorus')
  if (choruses.length) {
    const first = choruses[0]
    const varied = varyProgression(song.chords.slice(first.start, first.start + first.bars), r)
    for (const x of choruses) {
      for (let i = 0; i < x.bars; i++) {
        const src = varied[i % varied.length]
        const bar = x.start + i
        // Ô trống giữ nguyên trống.
        if (!isNoChord(chords[bar]) && !isNoChord(src)) chords[bar] = { ...chords[bar], degree: src.degree }
      }
    }
  }
  return { ...song, chords, sectionStyles, drumSeed: seed }
}
