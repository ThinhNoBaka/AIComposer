import { describe, expect, it } from 'vitest'
import { getMood, songFromMood } from '../core/moods'
import { generateMelody } from '../core/melody'
import { isInScale } from '../core/theory'
import { mapDrumGroups } from '../audio/voices'
import { applyMood, reducer, type History } from './store'

function hist(): History {
  return { past: [], present: songFromMood(getMood('vui')), future: [], lastKey: null, lastAt: 0 }
}

describe('lịch sử undo/redo', () => {
  it('undo rồi redo trả về đúng trạng thái', () => {
    let h = hist()
    const start = h.present
    h = reducer(h, { type: 'update', patch: (s) => ({ ...s, bpm: 100 }) })
    h = reducer(h, { type: 'update', patch: (s) => ({ ...s, bpm: 90 }) })
    expect(h.present.bpm).toBe(90)
    h = reducer(h, { type: 'undo' })
    expect(h.present.bpm).toBe(100)
    h = reducer(h, { type: 'undo' })
    expect(h.present).toBe(start)
    h = reducer(h, { type: 'undo' })
    expect(h.present).toBe(start)
    h = reducer(h, { type: 'redo' })
    expect(h.present.bpm).toBe(100)
  })

  it('thao tác liên tục cùng khoá được gộp thành một bước', () => {
    let h = hist()
    for (const bpm of [101, 102, 103, 104]) h = reducer(h, { type: 'update', patch: (s) => ({ ...s, bpm }), coalesce: 'bpm' })
    expect(h.past).toHaveLength(1)
    h = reducer(h, { type: 'undo' })
    expect(h.present.bpm).toBe(112)
  })

  it('thao tác mới xoá nhánh redo', () => {
    let h = hist()
    h = reducer(h, { type: 'update', patch: (s) => ({ ...s, bpm: 100 }) })
    h = reducer(h, { type: 'undo' })
    h = reducer(h, { type: 'update', patch: (s) => ({ ...s, bpm: 80 }) })
    expect(h.future).toHaveLength(0)
  })
})

describe('đổi mood', () => {
  it('giữ giai điệu (chuyển sang thang mới), đổi key, tempo, nhạc cụ', () => {
    const s0 = songFromMood(getMood('vui'))
    const s = { ...s0, melody: generateMelody(s0, { seed: 3 }), title: 'Bài của tôi' }
    const out = applyMood(s, 'buon')
    expect(out.title).toBe('Bài của tôi')
    expect(out.tonic).toBe(9)
    expect(out.mode).toBe('minor')
    expect(out.melody).toHaveLength(s.melody.length)
    for (const n of out.melody) expect(isInScale(n.pitch, 9, 'minor')).toBe(true)
    expect(out.tracks.melody.instrument).toBe('acoustic_grand_piano')
  })
})

describe('dò tên tiếng trống', () => {
  it('nhận ra các kiểu đặt tên thường gặp', () => {
    const m = mapDrumGroups(['kick', 'snare', 'clap', 'hihat-close', 'hihat-open', 'tom-low', 'tom-mid', 'tom-hi', 'cymbal'])
    expect(m).toMatchObject({ kick: 'kick', snare: 'snare', clap: 'clap', 'hihat-close': 'hihat-close', 'hihat-open': 'hihat-open', 'tom-low': 'tom-low', 'tom-mid': 'tom-mid', 'tom-high': 'tom-hi', crash: 'cymbal' })
    const m2 = mapDrumGroups(['BD', 'SD', 'CH', 'OH', 'LT', 'HT'])
    expect(m2.kick).toBe('BD')
    expect(m2.snare).toBe('SD')
    expect(m2['hihat-close']).toBe('CH')
    expect(m2['hihat-open']).toBe('OH')
    expect(m2.crash).toBeUndefined()
  })
})

describe('đổi cảm xúc cho bài đã hoàn thiện', () => {
  it('giữ cấu trúc và vòng hợp âm, đổi giọng và nhạc cụ', async () => {
    const { arrangeSong } = await import('../core/humming')
    const base = songFromMood(getMood('vui'))
    const done = arrangeSong({ ...base, melody: generateMelody(base, { seed: 3 }) }, 1, 120)
    const next = applyMood(done, 'buon')
    expect(next.sections).toEqual(done.sections)
    expect(next.chords).toEqual(done.chords)
    expect(next.bars).toBe(done.bars)
    expect(next.tonic).toBe(getMood('buon').tonic)
    for (const n of next.melody) expect(isInScale(n.pitch, next.tonic, next.mode)).toBe(true)
  })
})
