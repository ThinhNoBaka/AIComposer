import { describe, expect, it } from 'vitest'
import { drumHits } from './accompany'
import { varyArrangement } from './arrange'
import { GROOVE, grooveStyle, pickPattern } from './grooveModel'
import { getMood, songFromMood } from './moods'
import { STEPS_PER_BAR, validateSong, type Song } from './song'

const song = (moodId: string, patch: Partial<Song> = {}): Song => ({ ...songFromMood(getMood(moodId), 8), ...patch })

describe('trống học từ Groove MIDI', () => {
  it('có mẫu cho pop, ballad, lofi, dance; mẫu nào cũng có kick phách 1 và snare phách 2 hoặc 4', () => {
    for (const st of ['pop', 'ballad', 'lofi', 'dance'] as const) {
      const g = grooveStyle(st)!
      expect(g.patterns.length).toBeGreaterThan(3)
      for (const p of g.patterns) {
        expect(p.kick).toContain(0)
        expect(p.snare!.some((s) => s === 4 || s === 12)).toBe(true)
      }
    }
    expect(GROOVE.source).toContain('Groove MIDI')
  })

  it('thưa chọn mẫu ít nốt hơn dày', () => {
    const g = grooveStyle('pop')!
    const avg = (d: 0 | 2) => [1, 2, 3, 4, 5, 6, 7, 8].reduce((s, seed) => s + pickPattern(g, d, seed).hits, 0)
    expect(avg(0)).toBeLessThan(avg(2))
  })

  it('cùng bài thì cùng tiếng trống; lệch nhịp nhỏ, lực hợp lệ, không ra ngoài bài', () => {
    const s = song('vui')
    const a = drumHits(s)
    expect(drumHits(s)).toEqual(a)
    expect(a.length).toBeGreaterThan(8 * 4)
    for (const h of a) {
      expect(h.start).toBeGreaterThanOrEqual(0)
      expect(h.start).toBeLessThan(s.bars * STEPS_PER_BAR)
      expect(Math.abs(h.start - Math.round(h.start))).toBeLessThanOrEqual(0.125)
      expect(h.vel).toBeGreaterThanOrEqual(30)
      expect(h.vel).toBeLessThanOrEqual(127)
    }
    // Có nốt lệch khỏi lưới và lực không đều: nghe như người chơi.
    expect(a.some((h) => h.start !== Math.round(h.start))).toBe(true)
    expect(new Set(a.filter((h) => h.sound === 'snare').map((h) => h.vel)).size).toBeGreaterThan(1)
  })

  it('"Đều như máy" giữ mẫu viết tay cũ; biến tấu bản phối đổi mẫu', () => {
    const basic = drumHits(song('vui', { drumFeel: 'basic' }))
    expect(basic.every((h) => Number.isInteger(h.start))).toBe(true)
    const s = song('vui')
    const seeds = new Set([1, 2, 3, 4, 5, 6].map((seed) => JSON.stringify(drumHits({ ...s, drumSeed: varyArrangement(s, seed).drumSeed }).slice(0, 12))))
    expect(seeds.size).toBeGreaterThan(1)
    expect(validateSong({ ...s, drumFeel: 'groove', drumSeed: 3 })).toBeNull()
    expect(validateSong({ ...s, drumFeel: 'xyz' as 'groove' })).not.toBeNull()
  })

  it('kiểu Hào hùng (không có dữ liệu) vẫn dùng mẫu viết tay', () => {
    expect(grooveStyle('epic')).toBeNull()
  })
})
