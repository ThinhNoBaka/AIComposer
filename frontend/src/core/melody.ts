// Bộ sinh giai điệu theo luật: luôn đúng thang âm, nốt phách mạnh thuộc hợp âm,
// có motif lặp lại và kết câu về nốt chủ. Có seed nên kết quả lặp lại được.

import { createRng, type Rng } from './rng'
import { STEPS_PER_BAR, newId, type Note, type Song } from './song'
import { chordPcs, degreeToMidi, isNoChord, midiToDegree, snapToScale } from './theory'

/** Khoảng cao độ của giai điệu (C4..G5). */
export const MELODY_LOW = 60
export const MELODY_HIGH = 79

type Slot = [start: number, dur: number]

// Mẫu nhịp cho một ô nhịp (bước 1/16).
const RHYTHMS: Slot[][] = [
  [[0, 4], [4, 4], [8, 4], [12, 4]],
  [[0, 2], [2, 2], [4, 4], [8, 2], [10, 2], [12, 4]],
  [[0, 6], [6, 2], [8, 4], [12, 4]],
  [[0, 4], [4, 2], [6, 2], [8, 8]],
  [[2, 2], [4, 2], [6, 2], [8, 4], [12, 2], [14, 2]],
  [[0, 3], [3, 3], [6, 2], [8, 4], [12, 4]],
  [[0, 8], [8, 4], [12, 4]],
  [[0, 2], [2, 2], [4, 2], [6, 2], [8, 4], [12, 4]],
]

// Mẫu nhịp cho ô kết câu: ít nốt, nốt cuối dài.
const CADENCE_RHYTHMS: Slot[][] = [
  [[0, 4], [4, 4], [8, 8]],
  [[0, 6], [6, 2], [8, 8]],
  [[0, 12]],
  [[0, 2], [2, 2], [4, 4], [8, 8]],
]

function pc(midi: number): number {
  return ((midi % 12) + 12) % 12
}

type Ctx = {
  song: Song
  rng: Rng
  lowDeg: number
  highDeg: number
}

function clampDeg(ctx: Ctx, d: number): number {
  return Math.max(ctx.lowDeg, Math.min(ctx.highDeg, d))
}

function toMidi(ctx: Ctx, d: number): number {
  return degreeToMidi(d, ctx.song.tonic, ctx.song.mode)
}

/**
 * Bậc thuộc hợp âm gần bậc trước nhất, đồng thời kéo về "đường nét mục tiêu"
 * để giai điệu không dính mãi ở một vùng cao độ.
 */
function nearestChordTone(ctx: Ctx, bar: number, prev: number, maxLeap = 4, target = prev): number {
  const pcs = chordPcs(ctx.song.chords[bar], ctx.song.tonic, ctx.song.mode)
  const cands: number[] = []
  for (let d = ctx.lowDeg; d <= ctx.highDeg; d++) {
    if (pcs.includes(pc(toMidi(ctx, d)))) cands.push(d)
  }
  if (cands.length === 0) return clampDeg(ctx, prev)
  const near = cands.filter((d) => Math.abs(d - prev) <= maxLeap)
  const pool = near.length ? near : cands
  let best = pool[0]
  let bestScore = Infinity
  for (const d of pool) {
    const score = Math.abs(d - prev) + 0.7 * Math.abs(d - target) + (d === prev ? 1.6 : 0) + ctx.rng.next() * 1.5
    if (score < bestScore) {
      bestScore = score
      best = d
    }
  }
  return best
}

/** Đường nét hình vòm cho mỗi câu 4 ô: đi lên tới giữa câu rồi hạ xuống. */
function contourTarget(ctx: Ctx, bar: number, step: number, lift: number): number {
  const pos = ((bar % 4) + step / STEPS_PER_BAR) / 4
  const span = ctx.highDeg - ctx.lowDeg
  const base = ctx.lowDeg + span * 0.35 + lift
  return base + span * 0.35 * Math.sin(Math.PI * pos)
}

function nearestTonic(ctx: Ctx, prev: number): number {
  let best = prev
  let bestDist = Infinity
  for (let d = ctx.lowDeg; d <= ctx.highDeg; d++) {
    if (pc(toMidi(ctx, d)) === ctx.song.tonic && Math.abs(d - prev) < bestDist) {
      bestDist = Math.abs(d - prev)
      best = d
    }
  }
  return best
}

function isChordTone(ctx: Ctx, bar: number, d: number): boolean {
  return chordPcs(ctx.song.chords[bar], ctx.song.tonic, ctx.song.mode).includes(pc(toMidi(ctx, d)))
}

/** Bậc thấp nhất và cao nhất nằm trọn trong khoảng MELODY_LOW..MELODY_HIGH. */
export function melodyRange(song: Pick<Song, 'tonic' | 'mode'>): { lowDeg: number; highDeg: number } {
  let lowDeg = midiToDegree(MELODY_LOW, song.tonic, song.mode)
  if (degreeToMidi(lowDeg, song.tonic, song.mode) < MELODY_LOW) lowDeg += 1
  let highDeg = midiToDegree(MELODY_HIGH, song.tonic, song.mode)
  if (degreeToMidi(highDeg, song.tonic, song.mode) > MELODY_HIGH) highDeg -= 1
  return { lowDeg, highDeg }
}

export type MelodyOptions = {
  seed: number
  /** Ô nhịp bắt đầu sinh (mặc định 0). */
  fromBar?: number
  /** Ô nhịp kết thúc, không tính (mặc định hết bài). */
  toBar?: number
  /** Nốt đã có trước vùng sinh, để nối mượt. */
  previous?: Note[]
}

/** Ô chưa có hợp âm được coi như hợp âm chủ khi chọn nốt cho giai điệu. */
export function withTonicForRests(song: Song): Song {
  if (!song.chords.some(isNoChord)) return song
  return { ...song, chords: song.chords.map((c) => (isNoChord(c) ? { degree: 0, seventh: false } : c)) }
}

export function generateMelody(input: Song, opts: MelodyOptions): Note[] {
  const song = withTonicForRests(input)
  const rng = createRng(opts.seed)
  const { lowDeg, highDeg } = melodyRange(song)
  const ctx: Ctx = { song, rng, lowDeg, highDeg }
  const fromBar = opts.fromBar ?? 0
  const toBar = Math.min(opts.toBar ?? song.bars, song.bars)
  const notes: Note[] = []

  const prevNotes = (opts.previous ?? []).filter((n) => n.start < fromBar * STEPS_PER_BAR)
  const lastPrev = prevNotes.sort((a, b) => a.start - b.start).at(-1)
  let prev = lastPrev
    ? midiToDegree(lastPrev.pitch, song.tonic, song.mode)
    : Math.round((ctx.lowDeg + ctx.highDeg) / 2) - 1

  // Mỗi câu 4 ô: A B A' Kết. Motif A và B chọn một lần cho cả bài để có tính nhận diện.
  const motifA = rng.pick(RHYTHMS)
  let motifB = rng.pick(RHYTHMS)
  if (motifB === motifA) motifB = RHYTHMS[(RHYTHMS.indexOf(motifA) + 3) % RHYTHMS.length]
  const cadence = rng.pick(CADENCE_RHYTHMS)
  let motifDeltas: number[] | null = null
  const recent: number[] = []

  for (let bar = fromBar; bar < toBar; bar++) {
    const posInPhrase = bar % 4
    const isLastBar = bar === song.bars - 1
    const isPhraseEnd = posInPhrase === 3 || isLastBar
    const rhythm = isPhraseEnd ? cadence : posInPhrase === 1 ? motifB : motifA
    // Câu thứ hai của mỗi đoạn 8 ô đặt cao hơn một chút để bài có cao trào.
    const lift = Math.floor(bar / 4) % 2 === 1 ? 1.5 : 0
    const barStart = bar * STEPS_PER_BAR
    const degs: number[] = []

    rhythm.forEach(([start, dur], i) => {
      const strong = start % 8 === 0
      const lastInBar = i === rhythm.length - 1
      const target = contourTarget(ctx, bar, start, lift)
      let d: number

      if (isPhraseEnd && lastInBar) {
        // Câu cuối bài kết về nốt chủ; câu giữa kết về nốt thuộc hợp âm.
        d = isLastBar || bar % 8 === 7 ? nearestTonic(ctx, prev) : nearestChordTone(ctx, bar, prev, 3)
      } else if (posInPhrase === 2 && motifDeltas && i < motifDeltas.length) {
        // Lặp lại hình dáng motif A, bắt đầu từ một nốt hợp âm.
        if (i === 0) d = nearestChordTone(ctx, bar, prev, 4, target)
        else d = clampDeg(ctx, degs[0] + motifDeltas[i])
        if (strong && !isChordTone(ctx, bar, d)) {
          d = isChordTone(ctx, bar, d + 1) ? clampDeg(ctx, d + 1) : clampDeg(ctx, d - 1)
        }
      } else if (strong || i === 0) {
        d = nearestChordTone(ctx, bar, prev, 4, target)
      } else {
        const direction = target > prev + 0.5 ? 1 : target < prev - 0.5 ? -1 : rng.chance(0.5) ? 1 : -1
        const moves = direction > 0 ? [1, 1, 2, -1, 0, 1] : [-1, -1, -2, 1, 0, -1]
        d = clampDeg(ctx, prev + rng.pick(moves))
        // Không lặp một nốt quá 2 lần liên tiếp.
        const n = degs.length
        if (d === prev && n >= 2 && degs[n - 1] === degs[n - 2]) d = clampDeg(ctx, prev + direction) === prev ? clampDeg(ctx, prev - direction) : clampDeg(ctx, prev + direction)
      }

      // Chặn một nốt bị lặp quá 3 lần liên tiếp (trừ nốt kết câu).
      if (!(isPhraseEnd && lastInBar) && recent.length >= 3 && recent.slice(-3).every((x) => x === d)) {
        const alts = [d + 1, d - 1, d + 2, d - 2].map((x) => clampDeg(ctx, x)).filter((x) => x !== d)
        d = (strong ? alts.find((x) => isChordTone(ctx, bar, x)) : undefined) ?? alts[0] ?? d
      }
      degs.push(d)
      recent.push(d)
      prev = d
      notes.push({
        id: newId(),
        pitch: toMidi(ctx, d),
        start: barStart + start,
        dur,
        vel: Math.max(1, Math.min(127, (strong ? 96 : 82) + rng.int(-6, 6))),
      })
    })

    if (posInPhrase === 0) motifDeltas = degs.map((d) => d - degs[0])
  }
  return notes
}

/** Ô nhịp đầu tiên chưa có nốt nào sau nốt cuối cùng. */
export function nextEmptyBar(song: Song): number {
  if (song.melody.length === 0) return 0
  const end = Math.max(...song.melody.map((n) => n.start + n.dur))
  return Math.ceil(end / STEPS_PER_BAR)
}

/** Viết tiếp: sinh từ ô trống đầu tiên đến hết bài, giữ nguyên phần đã có. */
export function continueMelody(song: Song, seed: number): Note[] {
  const from = nextEmptyBar(song)
  if (from >= song.bars) return song.melody
  return [...song.melody, ...generateMelody(song, { seed, fromBar: from, previous: song.melody })]
}

/** Biến tấu: giữ nốt phách mạnh, đổi nhẹ các nốt còn lại và đôi khi tách nốt dài. */
export function varyMelody(song: Song, seed: number): Note[] {
  const rng = createRng(seed)
  const { lowDeg, highDeg } = melodyRange(song)
  const out: Note[] = []
  for (const n of song.melody) {
    const local = n.start % STEPS_PER_BAR
    const strong = local % 8 === 0
    if (strong) {
      out.push({ ...n })
      continue
    }
    const deg = midiToDegree(n.pitch, song.tonic, song.mode)
    if (n.dur >= 4 && n.dur % 2 === 0 && rng.chance(0.3)) {
      const half = n.dur / 2
      const d2 = Math.max(lowDeg, Math.min(highDeg, deg + rng.pick([-1, 1])))
      out.push({ ...n, dur: half })
      out.push({ ...n, id: newId(), start: n.start + half, dur: half, pitch: degreeToMidi(d2, song.tonic, song.mode) })
    } else if (rng.chance(0.5)) {
      const d = Math.max(lowDeg, Math.min(highDeg, deg + rng.pick([-1, 1])))
      out.push({ ...n, pitch: degreeToMidi(d, song.tonic, song.mode) })
    } else {
      out.push({ ...n })
    }
  }
  return out
}

/** Dịch giai điệu theo số bậc trong thang (cao hơn/thấp hơn mà không ra khỏi thang). */
export function shiftMelody(song: Song, degrees: number): Note[] {
  return song.melody.map((n) => {
    const d = midiToDegree(n.pitch, song.tonic, song.mode) + degrees
    return { ...n, pitch: Math.max(24, Math.min(108, degreeToMidi(d, song.tonic, song.mode))) }
  })
}

/** Chuyển giai điệu sang key/thang âm mới: dịch theo nốt chủ rồi làm tròn vào thang mới. */
export function remapMelody(notes: Note[], from: Pick<Song, 'tonic' | 'mode'>, to: Pick<Song, 'tonic' | 'mode'>): Note[] {
  let shift = (to.tonic - from.tonic + 12) % 12
  if (shift > 6) shift -= 12
  return notes.map((n) => ({ ...n, pitch: snapToScale(n.pitch + shift, to.tonic, to.mode) }))
}
