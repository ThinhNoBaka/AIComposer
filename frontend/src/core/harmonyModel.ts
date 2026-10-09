// Mô hình hoà âm học từ POP909 (ml/harmony): HMM với trạng thái là bậc hợp âm 0..6 của mỗi ô nhịp,
// quan sát là histogram 12 lớp cao độ của giai điệu trong ô (theo giọng, 0 = nốt chủ, trọng số = số phách).

import { STEPS_PER_BAR, type Song } from './song'
import { harmonyMode, type Mode } from './theory'
import trained from './harmonyModel.json'

export type ModeTables = {
  start: number[]
  trans: number[][]
  emit: number[][]
  prior?: number[]
  seventhRate?: number[]
}

export type HarmonyModelData = {
  version: number
  source: string
  emitWeight?: number
  modes: Partial<Record<string, ModeTables>>
}

/** Bảng log-xác suất đã chuẩn hoá, sẵn để giải mã. */
export type PreparedModel = {
  logStart: number[]
  logTrans: number[][]
  logEmit: number[][]
  /** log(emit / nền): nền là phân phối nốt "trung bình" theo tiên nghiệm các bậc. */
  logRatio: number[][]
  /** log tiên nghiệm của bậc, đã trừ trung bình (dương = bậc hay gặp). */
  logPrior: number[]
  emitWeight: number
}

export const HARMONY_MODEL = trained as HarmonyModelData

/** Độ hợp: tanh(log-tỉ số hợp lý mỗi phách / FIT_SCALE). 0.4 chọn theo phân bố trên POP909: hợp âm đúng có trung vị ≈ 0.7. */
const FIT_SCALE = 0.4
const MIN_P = 1e-4

function logNormalize(row: number[]): number[] {
  const clean = row.map((p) => (Number.isFinite(p) && p > MIN_P ? p : MIN_P))
  const sum = clean.reduce((a, b) => a + b, 0)
  return clean.map((p) => Math.log(p / sum))
}

function validTables(t: ModeTables | undefined): t is ModeTables {
  return (
    !!t &&
    Array.isArray(t.start) &&
    t.start.length === 7 &&
    Array.isArray(t.trans) &&
    t.trans.length === 7 &&
    t.trans.every((r) => Array.isArray(r) && r.length === 7) &&
    Array.isArray(t.emit) &&
    t.emit.length === 7 &&
    t.emit.every((r) => Array.isArray(r) && r.length === 12)
  )
}

const cache = new WeakMap<HarmonyModelData, Map<string, PreparedModel | null>>()

/**
 * Mô hình cho giọng của bài. Ngũ cung dùng mô hình của thang 7 nốt gốc (giống cách dựng hợp âm).
 * Trả null khi file mô hình không có giọng này (vd. dorian) để dùng luật cũ.
 */
export function modelFor(mode: Mode, data: HarmonyModelData = HARMONY_MODEL): PreparedModel | null {
  const key = harmonyMode(mode)
  let byMode = cache.get(data)
  if (!byMode) {
    byMode = new Map()
    cache.set(data, byMode)
  }
  if (byMode.has(key)) return byMode.get(key)!
  const t = data.modes?.[key]
  let prepared: PreparedModel | null = null
  if (validTables(t)) {
    const logEmit = t.emit.map(logNormalize)
    const prior = Array.isArray(t.prior) && t.prior.length === 7 ? logNormalize(t.prior).map(Math.exp) : Array(7).fill(1 / 7)
    const bg = Array.from({ length: 12 }, (_, pc) => prior.reduce((a, p, d) => a + p * Math.exp(logEmit[d][pc]), 0))
    const lp = prior.map(Math.log)
    const mean = lp.reduce((a, b) => a + b, 0) / 7
    prepared = {
      logStart: logNormalize(t.start),
      logTrans: t.trans.map(logNormalize),
      logEmit,
      logRatio: logEmit.map((row) => row.map((l, pc) => l - Math.log(bg[pc]))),
      logPrior: lp.map((l) => l - mean),
      emitWeight: data.emitWeight && data.emitWeight > 0 ? data.emitWeight : 1,
    }
  }
  byMode.set(key, prepared)
  return prepared
}

/** Histogram 12 lớp cao độ (so với nốt chủ) của giai điệu trong ô `bar`, đơn vị là phách. */
export function barHistogram(song: Song, bar: number): number[] {
  const start = bar * STEPS_PER_BAR
  const end = start + STEPS_PER_BAR
  const h = Array(12).fill(0) as number[]
  for (const n of song.melody) {
    const ov = Math.min(n.start + n.dur, end) - Math.max(n.start, start)
    if (ov <= 0) continue
    h[(((n.pitch - song.tonic) % 12) + 12) % 12] += ov / 4
  }
  return h
}

/** Log-likelihood của ô cho bậc `degree` (đã nhân trọng số emission). Ô không nốt = 0. */
export function emissionScore(model: PreparedModel, hist: number[], degree: number): number {
  let s = 0
  for (let pc = 0; pc < 12; pc++) if (hist[pc] > 0) s += hist[pc] * model.logEmit[degree][pc]
  return s * model.emitWeight
}

/**
 * Độ hợp -1..1 của bậc `degree` với ô có histogram `hist` (cùng thang với chordFit cũ).
 * Lấy log-tỉ số hợp lý so với nền, chia cho số phách có nốt để không phụ thuộc độ dài,
 * cộng tiên nghiệm của bậc (bậc hiếm như VII giảm bị trừ, càng ít nốt càng bị trừ nhiều), rồi nén bằng tanh.
 * Ô không có nốt trả 0.
 */
export function barFit(model: PreparedModel, hist: number[], degree: number): number {
  if (degree < 0 || degree > 6) return 0
  let total = 0
  let llr = 0
  for (let pc = 0; pc < 12; pc++) {
    if (hist[pc] <= 0) continue
    total += hist[pc]
    llr += hist[pc] * model.logRatio[degree][pc]
  }
  if (total === 0) return 0
  return Math.tanh((llr + model.logPrior[degree]) / Math.max(total, 1) / FIT_SCALE)
}

export type DecodeOptions = {
  /** Bậc hiện tại của từng ô (-1 = ô trống), để ưu tiên giữ hợp âm cũ khi không chắc. */
  current?: number[]
  /** Thưởng (nat) cho việc giữ hợp âm cũ ở ô có nốt. */
  keepBonus?: number
  /** Thưởng giữ hợp âm cũ ở ô không có nốt giai điệu. */
  keepBonusSilent?: number
  /** Thưởng cho ô cuối về bậc I. */
  endBonus?: number
}

/** Viterbi: chuỗi bậc 0..6 có xác suất hậu nghiệm lớn nhất, dài đúng bằng số histogram. */
export function viterbi(model: PreparedModel, hists: number[][], opts: DecodeOptions = {}): number[] {
  const n = hists.length
  if (n === 0) return []
  const { current = [], keepBonus = 0, keepBonusSilent = 0, endBonus = 0 } = opts
  const local = (bar: number, d: number) => {
    const h = hists[bar]
    let s = emissionScore(model, h, d)
    if (current[bar] === d) s += h.some((x) => x > 0) ? keepBonus : keepBonusSilent
    if (bar === n - 1 && d === 0) s += endBonus
    return s
  }
  let score = model.logStart.map((l, d) => l + local(0, d))
  const back: number[][] = [Array(7).fill(-1)]
  for (let bar = 1; bar < n; bar++) {
    const next: number[] = []
    const arg: number[] = []
    for (let d = 0; d < 7; d++) {
      let best = -Infinity
      let bi = 0
      for (let p = 0; p < 7; p++) {
        const v = score[p] + model.logTrans[p][d]
        if (v > best) {
          best = v
          bi = p
        }
      }
      next.push(best + local(bar, d))
      arg.push(bi)
    }
    score = next
    back.push(arg)
  }
  let last = 0
  for (let d = 1; d < 7; d++) if (score[d] > score[last]) last = d
  const path = [last]
  for (let bar = n - 1; bar > 0; bar--) path.unshift(back[bar][path[0]])
  return path
}
