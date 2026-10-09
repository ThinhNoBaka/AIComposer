// Gợi ý hợp âm: phương án thay thế cho một ô, và hoà âm lại cả bài theo giai điệu.

import { STEPS_PER_BAR, type Song } from './song'
import { chordFunction, chordPcs, type Chord, type ChordFunction } from './theory'

function pc(m: number) {
  return ((m % 12) + 12) % 12
}

/** Độ hợp (-1..1) giữa hợp âm và các nốt giai điệu trong một ô nhịp. Không có nốt thì trả 0. */
export function chordFit(song: Song, bar: number, chord: Chord): number {
  const start = bar * STEPS_PER_BAR
  const end = start + STEPS_PER_BAR
  const pcs = chordPcs(chord, song.tonic, song.mode)
  let total = 0
  let score = 0
  for (const n of song.melody) {
    const a = Math.max(n.start, start)
    const b = Math.min(n.start + n.dur, end)
    if (b <= a) continue
    const local = n.start - start
    const strong = n.start >= start && local % 8 === 0
    const w = (b - a) * (strong ? 2 : 1)
    total += w
    score += pcs.includes(pc(n.pitch)) ? w : -0.6 * w
  }
  return total === 0 ? 0 : score / total
}

export type ChordOption = { chord: Chord; fit: number; fn: ChordFunction; sameFunction: boolean }

/** Các hợp âm có thể thay cho ô `bar`, cùng chức năng xếp trước, rồi theo độ hợp với giai điệu. */
export function chordOptions(song: Song, bar: number): ChordOption[] {
  const current = song.chords[bar]
  const fn = chordFunction(current.degree)
  return [0, 1, 2, 3, 4, 5, 6]
    .filter((d) => d !== current.degree)
    .map((d) => {
      const chord = { degree: d, seventh: current.seventh }
      return { chord, fit: chordFit(song, bar, chord), fn: chordFunction(d), sameFunction: chordFunction(d) === fn }
    })
    .sort((a, b) => Number(b.sameFunction) - Number(a.sameFunction) || b.fit - a.fit)
}

/** Chi phí chuyển hợp âm: thưởng các bước quen tai (V→I, IV→V…), phạt lặp lại quá nhiều. */
function transitionCost(a: number, b: number): number {
  if (a === b) return 0.35
  const good: Record<number, number[]> = { 0: [3, 4, 5], 1: [4, 6], 2: [5, 3], 3: [4, 0, 1], 4: [0, 5], 5: [3, 1, 4], 6: [0, 2] }
  return good[a]?.includes(b) ? 0 : 0.25
}

/**
 * Hoà âm lại cả bài theo giai điệu (thuật toán Viterbi trên 7 bậc).
 * Ô không có nốt thì ưu tiên giữ hợp âm cũ.
 */
export function harmonize(song: Song): Chord[] {
  const seventh = song.chords[0]?.seventh ?? false
  const n = song.bars
  const degrees = [0, 1, 2, 3, 4, 5, 6]
  const cost: number[][] = []
  const back: number[][] = []
  for (let bar = 0; bar < n; bar++) {
    cost.push([])
    back.push([])
    for (const d of degrees) {
      const chord = { degree: d, seventh }
      let local = -chordFit(song, bar, chord) * 2
      if (song.chords[bar].degree === d) local -= 0.3 // giữ hợp âm cũ khi không chắc
      if (d === 6) local += 0.4 // hợp âm giảm nghe lạ với người mới
      if (bar === 0 && d === 0) local -= 0.4
      if (bar === n - 1 && d === 0) local -= 2 // kết về chủ
      if (bar === 0) {
        cost[bar].push(local)
        back[bar].push(-1)
      } else {
        let best = Infinity
        let arg = 0
        for (const p of degrees) {
          const c = cost[bar - 1][p] + transitionCost(p, d)
          if (c < best) {
            best = c
            arg = p
          }
        }
        cost[bar].push(best + local)
        back[bar].push(arg)
      }
    }
  }
  let last = 0
  for (const d of degrees) if (cost[n - 1][d] < cost[n - 1][last]) last = d
  const path = [last]
  for (let bar = n - 1; bar > 0; bar--) path.unshift(back[bar][path[0]])
  return path.map((degree) => ({ degree, seventh }))
}
