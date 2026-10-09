import { describe, expect, it } from 'vitest'
import { applyHumming, resizeSong } from './humming'
import { getMood, songFromMood } from './moods'
import { bassNotes, drumHits } from './accompany'
import { isInScale } from './theory'
import { validateSong } from './song'

const HUM = {
  bpm: 96,
  tonic: 7,
  mode: 'major',
  bars: 3,
  melody: [
    { pitch: 67, start: 0, dur: 4, vel: 100 },
    { pitch: 71, start: 4, dur: 4, vel: 90 },
    { pitch: 74, start: 8, dur: 8, vel: 95 },
    { pitch: 72, start: 16, dur: 4, vel: 90 },
    { pitch: 71, start: 20, dur: 4, vel: 90 },
    { pitch: 69, start: 24, dur: 8, vel: 90 },
    { pitch: 67, start: 32, dur: 12, vel: 90 },
  ],
}

describe('đưa bản ngân nga vào bài', () => {
  it('dùng giọng và tempo dò được, làm tròn 4 ô, tự hoà âm, có đệm', () => {
    const { song, dropped } = applyHumming(songFromMood(getMood('vui')), HUM, { useKey: true, useBpm: true, autoHarmony: true })
    expect(dropped).toBe(0)
    expect(song.tonic).toBe(7)
    expect(song.mode).toBe('major')
    expect(song.bpm).toBe(96)
    expect(song.bars).toBe(4)
    expect(song.chords).toHaveLength(4)
    expect(song.chords.at(-1)!.degree).toBe(0)
    expect(song.melody.map((n) => n.pitch)).toEqual(HUM.melody.map((n) => n.pitch))
    expect(new Set(song.melody.map((n) => n.id)).size).toBe(song.melody.length)
    expect(bassNotes(song).length).toBeGreaterThan(0)
    expect(drumHits(song).length).toBeGreaterThan(0)
  })

  it('giữ giọng hiện tại thì nốt được đưa vào thang hiện tại', () => {
    const base = songFromMood(getMood('buon')) // La thứ
    const { song } = applyHumming(base, { ...HUM, melody: [...HUM.melody, { pitch: 66, start: 44, dur: 2, vel: 90 }] }, { useKey: false, useBpm: false, autoHarmony: false })
    expect(song.tonic).toBe(9)
    expect(song.bpm).toBe(base.bpm)
    for (const n of song.melody) expect(isInScale(n.pitch, 9, 'minor')).toBe(true)
  })

  it('bản ngân quá dài bị cắt ở 16 ô và báo số nốt bỏ', () => {
    const long = { ...HUM, bars: 20, melody: Array.from({ length: 80 }, (_, i) => ({ pitch: 67, start: i * 4, dur: 4, vel: 90 })) }
    const { song, dropped } = applyHumming(songFromMood(getMood('vui')), long, { useKey: true, useBpm: true, autoHarmony: true })
    expect(song.bars).toBe(16)
    expect(dropped).toBe(16)
    expect(Math.max(...song.melody.map((n) => n.start + n.dur))).toBeLessThanOrEqual(256)
  })
})

describe('đổi độ dài bài', () => {
  it('thêm ô thì lặp vòng hợp âm, bớt ô thì cắt nốt và hiệu ứng', () => {
    const base = { ...songFromMood(getMood('vui'), 4), fx: [{ id: 'a', fx: 'riser', start: 60 }] }
    base.chords = [0, 5, 3, 4].map((degree) => ({ degree, seventh: false }))
    const longer = resizeSong(base, 8)
    expect(longer.chords.map((c) => c.degree)).toEqual([0, 5, 3, 4, 0, 5, 3, 4])
    const withNotes = { ...longer, melody: [{ id: 'x', pitch: 60, start: 28, dur: 8, vel: 90 }, { id: 'y', pitch: 62, start: 40, dur: 4, vel: 90 }] }
    const shorter = resizeSong(withNotes, 2)
    expect(shorter.chords).toHaveLength(2)
    expect(shorter.melody).toEqual([{ id: 'x', pitch: 60, start: 28, dur: 4, vel: 90 }])
    expect(shorter.fx).toHaveLength(0)
    expect(validateSong(shorter)).toBeNull()
  })
})
