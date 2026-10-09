import { afterEach, describe, expect, it, vi } from 'vitest'
import { alignLyrics, melodyFromLyrics, parseLyrics, type Tone } from './lyrics'
import { getMood, songFromMood } from './moods'
import type { Note } from './song'
import { isInScale } from './theory'
import {
  expectedDegreeMove,
  getToneModel,
  hintThreshold,
  loadToneModel,
  parseToneModel,
  sampleDegreeMove,
  setToneModel,
  tailProbability,
  type ToneModel,
} from './toneModel'

const TONES: Tone[] = ['ngang', 'huyen', 'sac', 'hoi', 'nga', 'nang']
const BUCKETS = [
  { name: 'down_big', lo: -24, hi: -5, deg: -3 },
  { name: 'down', lo: -4, hi: -3, deg: -2 },
  { name: 'down_step', lo: -2, hi: -1, deg: -1 },
  { name: 'same', lo: 0, hi: 0, deg: 0 },
  { name: 'up_step', lo: 1, hi: 2, deg: 1 },
  { name: 'up', lo: 3, hi: 4, deg: 2 },
  { name: 'up_big', lo: 5, hi: 24, deg: 3 },
]

/** Bảng giả: mọi cặp thanh dùng chung một phân bố, có thể ghi đè từng cặp. */
function makeModel(all: number[], overrides: Record<string, number[]> = {}): ToneModel {
  const table: Record<string, number[]> = {}
  for (const a of TONES) for (const b of TONES) table[`${a}|${b}`] = overrides[`${a}|${b}`] ?? all
  return { version: 1, buckets: BUCKETS, table, n: 1000 }
}

const STAY = [0, 0, 0, 1, 0, 0, 0]
const note = (id: string, pitch: number, start: number, dur = 2): Note => ({ id, pitch, start, dur, vel: 90 })

afterEach(() => {
  setToneModel(null)
  vi.unstubAllGlobals()
})

describe('đọc bảng thanh điệu', () => {
  it('chuẩn hoá xác suất, từ chối dữ liệu sai', () => {
    const m = parseToneModel(makeModel([1, 1, 1, 2, 1, 1, 1]))!
    expect(m.table['ngang|sac'].reduce((s, p) => s + p, 0)).toBeCloseTo(1)
    expect(parseToneModel(null)).toBeNull()
    expect(parseToneModel({ ...makeModel(STAY), version: 2 })).toBeNull()
    expect(parseToneModel({ ...makeModel(STAY), table: { 'ngang|sac': [1, 2] } })).toBeNull()
    expect(parseToneModel('<!doctype html>')).toBeNull()
    expect(setToneModel({ version: 1 })).toBe(false)
    expect(getToneModel()).toBeNull()
  })

  it('rút bước đi, tính hướng và xác suất đuôi', () => {
    setToneModel(makeModel(STAY, { 'ngang|sac': [0, 0, 0, 0.1, 0.2, 0.5, 0.2] }))
    expect(sampleDegreeMove('ngang', 'huyen', 0.5)).toBe(0)
    expect(sampleDegreeMove('ngang', 'sac', 0.05)).toBe(0)
    expect(sampleDegreeMove('ngang', 'sac', 0.25)).toBe(1)
    expect(sampleDegreeMove('ngang', 'sac', 0.99)).toBe(3)
    expect(expectedDegreeMove('ngang', 'sac')).toBeCloseTo(0.2 + 1 + 0.6)
    expect(tailProbability('ngang', 'sac', 3)).toBeCloseTo(0.7)
    expect(tailProbability('ngang', 'sac', 1)).toBeCloseTo(0.9)
    expect(tailProbability('ngang', 'sac', -2)).toBeCloseTo(0)
    expect(tailProbability('ngang', 'sac', 0)).toBe(1)
    expect(hintThreshold()).toBe(0.1)
  })

  it('không có bảng thì các hàm trả null', () => {
    expect(sampleDegreeMove('ngang', 'sac', 0.5)).toBeNull()
    expect(tailProbability('ngang', 'sac', 3)).toBeNull()
  })
})

describe('tải bảng khi mở app', () => {
  it('404 hoặc trang HTML thì im lặng bỏ qua', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })))
    await expect(loadToneModel('/models/tone_model.json')).resolves.toBeNull()
    setToneModel(null)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html><html></html>', { status: 200 })))
    await expect(loadToneModel()).resolves.toBeNull()
    setToneModel(null)
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('mạng lỗi'))))
    await expect(loadToneModel()).resolves.toBeNull()
    expect(getToneModel()).toBeNull()
  })

  it('có file hợp lệ thì nạp đúng một lần', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(makeModel(STAY)), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const [a, b] = await Promise.all([loadToneModel(), loadToneModel()])
    expect(a).not.toBeNull()
    expect(b).toBe(a)
    expect(getToneModel()).toBe(a)
    await loadToneModel()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toMatch(/models\/tone_model\.json$/)
  })
})

describe('giai điệu theo lời dùng bảng học được', () => {
  const lines = parseLyrics('em đi trên con đường nhỏ\nchiều mưa rơi nhẹ bay')

  it('bảng bảo đứng yên thì các chữ giữa câu giữ nguyên cao độ', () => {
    setToneModel(makeModel(STAY))
    const song = songFromMood(getMood('vui'))
    const { melody } = melodyFromLyrics(song, lines, 7)
    expect(melody).toHaveLength(11)
    expect(melody.every((n) => isInScale(n.pitch, song.tonic, song.mode))).toBe(true)
    const first = melody.slice(0, 5).map((n) => n.pitch)
    expect(new Set(first).size).toBe(1)
  })

  it('bảng bảo đi lên thì giai điệu đi lên, kể cả chữ thanh huyền', () => {
    setToneModel(makeModel([0, 0, 0, 0, 1, 0, 0]))
    const song = songFromMood(getMood('vui'))
    const { melody } = melodyFromLyrics(song, parseLyrics('em về nhà mình'), 3)
    for (let i = 1; i < 3; i++) expect(melody[i].pitch).toBeGreaterThan(melody[i - 1].pitch)
  })

  it('bỏ bảng thì quay về luật cũ (cùng seed cho cùng giai điệu như chưa từng nạp)', () => {
    const song = songFromMood(getMood('vui'))
    const before = melodyFromLyrics(song, lines, 11).melody.map((n) => n.pitch)
    setToneModel(makeModel(STAY))
    setToneModel(null)
    expect(melodyFromLyrics(song, lines, 11).melody.map((n) => n.pitch)).toEqual(before)
  })
})

describe('cảnh báo thanh điệu dùng bảng học được', () => {
  const melody = [note('a', 64, 0), note('b', 71, 2)]

  it('bước nhảy hiếm gặp với cặp thanh thì cảnh báo', () => {
    // Trong "dữ liệu", ngang → huyền gần như luôn đi xuống.
    setToneModel(makeModel(STAY, { 'ngang|huyen': [0.3, 0.3, 0.3, 0.05, 0.03, 0.01, 0.01] }))
    const al = alignLyrics(parseLyrics('em về'), melody)
    expect(al.hints).toHaveLength(1)
    expect(al.hints[0]).toMatchObject({ noteId: 'b', went: 'up', heard: 'vê', fix: 'lower' })
  })

  it('bước nhảy hay gặp thì không cảnh báo, dù luật cũ sẽ cảnh báo', () => {
    expect(alignLyrics(parseLyrics('em về'), melody).hints).toHaveLength(1) // luật cũ
    setToneModel(makeModel(STAY, { 'ngang|huyen': [0.05, 0.05, 0.1, 0.1, 0.2, 0.2, 0.3] }))
    expect(alignLyrics(parseLyrics('em về'), melody).hints).toHaveLength(0)
  })

  it('ngưỡng cảnh báo lấy từ file nếu có', () => {
    setToneModel({ ...makeModel(STAY, { 'ngang|huyen': [0.3, 0.2, 0.2, 0.1, 0.1, 0.05, 0.05] }), hint_threshold: 0.05 })
    expect(hintThreshold()).toBe(0.05)
    // P(lên từ 5 nửa cung trở lên) = 0.05, không nhỏ hơn ngưỡng 0.05 → không cảnh báo.
    expect(alignLyrics(parseLyrics('em về'), melody).hints).toHaveLength(0)
  })
})
