// Nhạc lý cơ bản: thang âm, bậc, hợp âm. Mọi hàm ở đây là hàm thuần để test được.

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

export type Mode = 'major' | 'minor' | 'dorian' | 'majorPentatonic' | 'minorPentatonic'

// Khoảng cách (nửa cung) của từng bậc so với nốt chủ.
export const SCALES: Record<Mode, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  majorPentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
}

export function noteNameToPc(name: string): number {
  const pc = NOTE_NAMES.indexOf(name as (typeof NOTE_NAMES)[number])
  if (pc < 0) throw new Error(`Tên nốt không hợp lệ: ${name}`)
  return pc
}

export function midiToName(midi: number): string {
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`
}

/**
 * Chỉ số bậc liên tục: degree 0 = nốt chủ ở quãng tám MIDI 0 (C-1..B-1 dịch theo key).
 * degree = octave * scaleLength + index.
 */
export function degreeToMidi(degree: number, tonicPc: number, mode: Mode): number {
  const scale = SCALES[mode]
  const len = scale.length
  const octave = Math.floor(degree / len)
  const idx = ((degree % len) + len) % len
  return tonicPc + octave * 12 + scale[idx]
}

/** Bậc gần nhất của một cao độ MIDI. Nốt ngoài thang âm được làm tròn về bậc gần nhất (ưu tiên bậc thấp khi hoà). */
export function midiToDegree(midi: number, tonicPc: number, mode: Mode): number {
  const scale = SCALES[mode]
  const len = scale.length
  const rel = midi - tonicPc
  const octave = Math.floor(rel / 12)
  const within = rel - octave * 12
  let best = 0
  let bestDist = Infinity
  // Xét cả bậc của quãng tám kế bên để làm tròn đúng ở biên (vd. B gần C trên).
  for (let i = 0; i <= len; i++) {
    const semis = i === len ? 12 : scale[i]
    const d = Math.abs(within - semis)
    if (d < bestDist) {
      bestDist = d
      best = i
    }
  }
  return octave * len + best
}

export function isInScale(midi: number, tonicPc: number, mode: Mode): boolean {
  const pc = (((midi - tonicPc) % 12) + 12) % 12
  return SCALES[mode].includes(pc)
}

export function snapToScale(midi: number, tonicPc: number, mode: Mode): number {
  return degreeToMidi(midiToDegree(midi, tonicPc, mode), tonicPc, mode)
}

/** Thang âm dùng để dựng hợp âm: ngũ cung dựng hợp âm theo thang 7 nốt gốc. */
export function harmonyMode(mode: Mode): 'major' | 'minor' | 'dorian' {
  if (mode === 'majorPentatonic') return 'major'
  if (mode === 'minorPentatonic') return 'minor'
  return mode
}

export type Chord = {
  /** Bậc gốc 0..6 trong thang 7 nốt. */
  degree: number
  seventh: boolean
}

/** Cao độ các nốt của hợp âm (quãng tám cho trước của nốt gốc, đã xếp tăng dần). */
export function chordPitches(chord: Chord, tonicPc: number, mode: Mode, rootOctave = 3): number[] {
  const hm = harmonyMode(mode)
  // Tên quãng tám n (C4) ứng với khối MIDI thứ n+1 (C4 = 60 = 5 * 12).
  const base = (rootOctave + 1) * 7 + chord.degree
  const steps = chord.seventh ? [0, 2, 4, 6] : [0, 2, 4]
  return steps.map((s) => degreeToMidi(base + s, tonicPc, hm))
}

/** Các lớp cao độ (0..11) thuộc hợp âm. */
export function chordPcs(chord: Chord, tonicPc: number, mode: Mode): number[] {
  return chordPitches(chord, tonicPc, mode).map((p) => ((p % 12) + 12) % 12)
}

export function chordName(chord: Chord, tonicPc: number, mode: Mode): string {
  const [r, t, f, s] = chordPitches(chord, tonicPc, mode)
  const third = t - r
  const fifth = f - r
  let quality = ''
  if (third === 3 && fifth === 7) quality = 'm'
  else if (third === 3 && fifth === 6) quality = 'dim'
  else if (third === 4 && fifth === 8) quality = 'aug'
  let name = NOTE_NAMES[((r % 12) + 12) % 12] + quality
  if (chord.seventh && s !== undefined) {
    const sev = s - r
    if (quality === '' && sev === 11) name += 'maj7'
    else if (quality === 'dim' && sev === 10) name = name.replace('dim', 'm7b5')
    else name += '7'
  }
  return name
}

// Chức năng hoà âm, đặt tên đời thường cho người không biết nhạc lý.
export type ChordFunction = 'home' | 'move' | 'tension'

export function chordFunction(degree: number): ChordFunction {
  const d = ((degree % 7) + 7) % 7
  if (d === 0 || d === 2 || d === 5) return 'home'
  if (d === 1 || d === 3) return 'move'
  return 'tension'
}

export const FUNCTION_LABEL: Record<ChordFunction, string> = {
  home: 'Ổn định',
  move: 'Chuyển động',
  tension: 'Căng, muốn về',
}

export const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII']
