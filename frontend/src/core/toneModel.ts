// Bảng "thanh điệu → hướng giai điệu" học từ bài hát tiếng Việt (ml/vn_tone/train.py xuất ra
// public/models/tone_model.json). Có bảng thì viết giai điệu theo lời và cảnh báo thanh điệu dùng xác suất học được;
// không có file (hoặc file hỏng) thì lyrics.ts dùng luật TONE_HEIGHT như cũ.

import type { Tone } from './lyrics'

export type ToneBucket = {
  name: string
  /** Khoảng cách tính bằng nửa cung, từ lo tới hi (kể cả hai đầu). */
  lo: number
  hi: number
  /** Số bậc thang âm tương ứng khi sinh giai điệu. */
  deg: number
}

export type ToneModel = {
  version: number
  buckets: ToneBucket[]
  /** "thanhTrước|thanhNày" → xác suất từng nhóm khoảng cách, cùng thứ tự với buckets. */
  table: Record<string, number[]>
  n: number
  /** Xác suất dưới mức này thì cảnh báo chữ dễ nghe sai. */
  hint_threshold?: number
}

export const TONE_MODEL_VERSION = 1
export const DEFAULT_HINT_THRESHOLD = 0.1
const TONES: readonly Tone[] = ['ngang', 'huyen', 'sac', 'hoi', 'nga', 'nang']

let current: ToneModel | null = null
let loading: Promise<ToneModel | null> | null = null

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

/** Kiểm tra và chuẩn hoá (xác suất mỗi dòng cộng lại bằng 1). Sai định dạng thì trả null. */
export function parseToneModel(raw: unknown): ToneModel | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Partial<ToneModel>
  if (m.version !== TONE_MODEL_VERSION || !Array.isArray(m.buckets) || !m.buckets.length || !m.table || typeof m.table !== 'object') return null
  const buckets: ToneBucket[] = []
  for (const b of m.buckets) {
    if (!b || !finite(b.lo) || !finite(b.hi) || !finite(b.deg) || b.lo > b.hi) return null
    buckets.push({ name: String(b.name ?? ''), lo: b.lo, hi: b.hi, deg: Math.round(b.deg) })
  }
  const table: Record<string, number[]> = {}
  for (const a of TONES)
    for (const b of TONES) {
      const row = (m.table as Record<string, unknown>)[`${a}|${b}`]
      if (row === undefined) continue // thiếu cặp nào thì cặp đó dùng luật
      if (!Array.isArray(row) || row.length !== buckets.length || !row.every((p) => finite(p) && p >= 0)) return null
      const sum = row.reduce((s: number, p: number) => s + p, 0)
      if (sum <= 0) return null
      table[`${a}|${b}`] = row.map((p: number) => p / sum)
    }
  if (!Object.keys(table).length) return null
  const hint = finite(m.hint_threshold) && m.hint_threshold > 0 && m.hint_threshold < 1 ? m.hint_threshold : undefined
  return { version: m.version, buckets, table, n: finite(m.n) ? m.n : 0, ...(hint !== undefined ? { hint_threshold: hint } : {}) }
}

/** Đặt (hoặc bỏ, với null) bảng đang dùng. Trả về false nếu dữ liệu sai định dạng (khi đó giữ nguyên bảng cũ). */
export function setToneModel(model: unknown): boolean {
  if (model === null) {
    current = null
    loading = null
    return true
  }
  const parsed = parseToneModel(model)
  if (!parsed) return false
  current = parsed
  return true
}

export function getToneModel(): ToneModel | null {
  return current
}

/**
 * Tải bảng một lần khi mở app. Không có file (404), mạng lỗi hay trả về trang HTML thì im lặng bỏ qua
 * và app dùng luật cũ.
 */
export function loadToneModel(url = `${import.meta.env.BASE_URL}models/tone_model.json`): Promise<ToneModel | null> {
  if (current) return Promise.resolve(current)
  if (loading) return loading
  loading = (async () => {
    try {
      const res = await fetch(url, { cache: 'no-cache' })
      if (!res.ok) return null
      const data: unknown = await res.json()
      return setToneModel(data) ? current : null
    } catch {
      return null
    }
  })()
  return loading
}

/** Phân bố nhóm khoảng cách cho cặp thanh, null nếu chưa có bảng hoặc bảng thiếu cặp này. */
export function intervalPreference(prev: Tone, tone: Tone): { bucket: ToneBucket; p: number }[] | null {
  const row = current?.table[`${prev}|${tone}`]
  if (!current || !row) return null
  return current.buckets.map((bucket, i) => ({ bucket, p: row[i] }))
}

/** Rút ngẫu nhiên số bậc dịch chuyển theo xác suất học được; `u` là số ngẫu nhiên trong [0, 1). */
export function sampleDegreeMove(prev: Tone, tone: Tone, u: number): number | null {
  const pref = intervalPreference(prev, tone)
  if (!pref) return null
  let acc = 0
  for (const { bucket, p } of pref) {
    acc += p
    if (u < acc) return bucket.deg
  }
  return pref[pref.length - 1].bucket.deg
}

/** Số bậc dịch chuyển trung bình (dấu cho biết nên đi lên hay xuống). */
export function expectedDegreeMove(prev: Tone, tone: Tone): number | null {
  const pref = intervalPreference(prev, tone)
  return pref ? pref.reduce((s, { bucket, p }) => s + bucket.deg * p, 0) : null
}

/**
 * Xác suất giai điệu đi cùng hướng và xa ít nhất bằng `semitones` (vd. nhảy lên 5 nửa cung → P(lên từ nhóm chứa 5 trở lên)).
 * Nhỏ nghĩa là trong bài hát thật hiếm khi gặp: dễ làm chữ nghe thành chữ khác.
 */
export function tailProbability(prev: Tone, tone: Tone, semitones: number): number | null {
  const pref = intervalPreference(prev, tone)
  if (!pref) return null
  if (semitones === 0) return 1
  const iv = Math.round(semitones)
  const idx = pref.findIndex(({ bucket }) => bucket.lo <= iv && iv <= bucket.hi)
  const ref = idx >= 0 ? pref[idx].bucket : iv > 0 ? pref[pref.length - 1].bucket : pref[0].bucket
  return pref
    .filter(({ bucket }) => (iv > 0 ? bucket.lo >= ref.lo && bucket.lo > 0 : bucket.hi <= ref.hi && bucket.hi < 0))
    .reduce((s, { p }) => s + p, 0)
}

export function hintThreshold(): number {
  return current?.hint_threshold ?? DEFAULT_HINT_THRESHOLD
}
