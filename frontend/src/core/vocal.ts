// Phần tính toán thuần của tab Giọng hát: bù trễ khi thu, đổi nốt giai điệu sang giây,
// vẽ đường cao độ, và chỗ bắt đầu phát bản thu khi phát bài từ giữa chừng.

import { stepSeconds, type Note } from './song'

/** Độ trễ ước lượng (ms) giữa lúc nhạc nền được hẹn giờ và lúc giọng hát tương ứng vào tới bản thu. */
export function estimateLatencyMs(ctx: { outputLatency?: number; baseLatency?: number }, recorderDelaySec = 0): number {
  const out = Number.isFinite(ctx.outputLatency) ? (ctx.outputLatency as number) : 0
  const base = Number.isFinite(ctx.baseLatency) ? (ctx.baseLatency as number) : 0
  return Math.max(0, (out + base + Math.max(0, recorderDelaySec)) * 1000)
}

/**
 * Mốc của bài (ms) ứng với mẫu đầu tiên của bản thu, đã trừ độ trễ.
 * - `playFromSec`: vị trí trong bài (giây) mà nhạc nền bắt đầu phát;
 * - `playAt`: thời điểm (giây, đồng hồ AudioContext) nhạc nền bắt đầu ở vị trí đó;
 * - `recStartAt`: thời điểm (cùng đồng hồ) gọi bắt đầu thu;
 * - `latencyMs`: độ trễ tự ước lượng; `nudgeMs`: bù thêm bằng tay.
 */
export function takeOffsetMs(opts: { playFromSec: number; playAt: number; recStartAt: number; latencyMs: number; nudgeMs?: number }): number {
  const songPosAtRec = opts.playFromSec + (opts.recStartAt - opts.playAt)
  return Math.round(songPosAtRec * 1000 - opts.latencyMs - (opts.nudgeMs ?? 0))
}

export type NoteSeconds = { pitch: number; start_s: number; end_s: number }

/** Nốt giai điệu đổi sang giây theo thời gian bài (gửi cho API chỉnh cao độ). `shiftSec` cộng thêm vào mọi mốc. */
export function notesToSeconds(melody: Note[], bpm: number, shiftSec = 0): NoteSeconds[] {
  const st = stepSeconds(bpm)
  return [...melody]
    .sort((a, b) => a.start - b.start)
    .map((n) => ({ pitch: n.pitch, start_s: round3(n.start * st + shiftSec), end_s: round3((n.start + n.dur) * st + shiftSec) }))
}

const round3 = (x: number) => Math.round(x * 1000) / 1000

/**
 * Đường SVG của một dãy cao độ (MIDI, null = không có giọng) lấy mẫu đều `hop` giây.
 * Mỗi đoạn có giọng là một nét riêng (M ... L ...).
 */
export function f0Path(values: (number | null)[], hop: number, x: (t: number) => number, y: (p: number) => number): string {
  const parts: string[] = []
  let open = false
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      open = false
      return
    }
    parts.push(`${open ? 'L' : 'M'}${fmt(x(i * hop))} ${fmt(y(v))}`)
    open = true
  })
  return parts.join(' ')
}

const fmt = (n: number) => String(Math.round(n * 10) / 10)

/** Khoảng cao độ (MIDI) để vẽ: bao cả hai đường và nốt giai điệu, nới 2 nửa cung mỗi bên. */
export function pitchRange(curves: (number | null)[][], notes: number[] = []): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (const c of curves)
    for (const v of c) {
      if (v === null || !Number.isFinite(v)) continue
      lo = Math.min(lo, v)
      hi = Math.max(hi, v)
    }
  for (const p of notes) {
    lo = Math.min(lo, p)
    hi = Math.max(hi, p)
  }
  if (!Number.isFinite(lo)) return [55, 79]
  return [Math.floor(lo) - 2, Math.ceil(hi) + 2]
}

/**
 * Phát bài từ vị trí `songPosSec` (giây trong bài): bản thu đặt ở `offsetSec`, dài `bufDur`.
 * Trả về chờ bao lâu rồi phát từ giây nào của bản thu; null nếu vị trí này đã qua hết bản thu.
 */
export function vocalStartPlan(songPosSec: number, offsetSec: number, bufDur: number): { delay: number; bufOffset: number } | null {
  if (songPosSec < offsetSec) return { delay: offsetSec - songPosSec, bufOffset: 0 }
  const bufOffset = songPosSec - offsetSec
  if (bufOffset >= bufDur) return null
  return { delay: 0, bufOffset }
}
