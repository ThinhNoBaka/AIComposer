// Kiểu trống học từ Groove MIDI (ml/drums/train_groove.py): mẫu ô nhịp tay trống thật hay chơi, lực đánh và độ lệch nhịp
// trung bình ở từng bước, vài mẫu dồn trống. Dùng thay mẫu viết tay khi bài để "Tay trống thật" (mặc định).

import type { DrumSound } from './accompany'
import { createRng } from './rng'
import type { DrumStyle } from './song'
import trained from './grooveModel.json'

export type GroovePattern = { weight: number; hits: number } & Partial<Record<DrumSound, number[]>>
type LaneFeel = { vel: (number | null)[]; offset: (number | null)[]; velStd: number }
export type GrooveStyle = { patterns: GroovePattern[]; fills: GroovePattern[]; feel: Partial<Record<DrumSound, LaneFeel>> }
export type GrooveModelData = { version: number; source: string; steps: number; styles: Partial<Record<DrumStyle, GrooveStyle>> }

export const GROOVE = trained as unknown as GrooveModelData
export const GROOVE_SOUNDS: DrumSound[] = ['kick', 'snare', 'hihat-close', 'hihat-open', 'tom-low', 'tom-mid', 'tom-high', 'crash']
/** Lệch nhịp học được chỉ áp một nửa và không quá 1/8 bước, đủ nghe "người chơi" mà không lệch phách. */
const OFFSET_SCALE = 0.5
const MAX_OFFSET = 0.125

export function grooveStyle(style: DrumStyle): GrooveStyle | null {
  const g = GROOVE.styles[style]
  return g && g.patterns.length ? g : null
}

/** Chọn mẫu theo độ dày (thưa: các mẫu ít nốt, dày: nhiều nốt), bốc thăm theo tần suất tay trống dùng. */
export function pickPattern(g: GrooveStyle, density: 0 | 1 | 2, seed: number): GroovePattern {
  const sorted = [...g.patterns].sort((a, b) => a.hits - b.hits)
  const third = Math.max(1, Math.ceil(sorted.length / 3))
  const pool = density === 0 ? sorted.slice(0, third) : density === 2 ? sorted.slice(-Math.max(1, Math.ceil(sorted.length / 2))) : sorted
  const total = pool.reduce((s, p) => s + p.weight, 0)
  let x = createRng(seed).next() * total
  for (const p of pool) {
    x -= p.weight
    if (x <= 0) return p
  }
  return pool[pool.length - 1]
}

export function pickFill(g: GrooveStyle, seed: number): GroovePattern | null {
  // Chỉ dùng fill có đủ nốt ở nửa sau ô (chỗ chèn vào cuối câu).
  const ok = g.fills.filter((f) => GROOVE_SOUNDS.reduce((n, s) => n + (f[s]?.filter((x) => x >= 8).length ?? 0), 0) >= 3)
  return ok.length ? ok[createRng(seed).int(0, ok.length - 1)] : null
}

/** Lực (0..127) và vị trí (bước, có phần lẻ) của một nốt theo cảm giác tay trống đã học. */
export function feelHit(g: GrooveStyle, sound: DrumSound, step: number, fallbackVel: number, jitter: number): { vel: number; offset: number } {
  const f = g.feel[sound]
  const s = ((step % 16) + 16) % 16
  const base = f?.vel[s] != null ? f.vel[s]! * 127 : fallbackVel
  const vel = Math.round(Math.max(30, Math.min(127, base + jitter * (f?.velStd ?? 0.06) * 127)))
  const o = f?.offset[s] ?? 0
  return { vel, offset: Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, o * OFFSET_SCALE)) }
}

/** Số ngẫu nhiên ổn định theo (seed, ô, bước): phát lại hay xuất file đều ra đúng một kết quả. */
export function stableJitter(seed: number, bar: number, step: number, lane: number): number {
  return createRng((seed * 7919 + bar * 131 + step * 17 + lane * 3) >>> 0).next() * 2 - 1
}
