import { describe, expect, it } from 'vitest'
import { addRound, appendHumming, applyHumming, arrangeSong, canAppend, contentEndBar, extendSong, fitShift, formatDuration, resizeSong, songSeconds } from './humming'
import { getMood, songFromMood } from './moods'
import { bassNotes, drumHits } from './accompany'
import { isInScale } from './theory'
import { MAX_BARS, validateSong } from './song'

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

  it('bản ngân quá dài bị cắt ở MAX_BARS ô và báo số nốt bỏ', () => {
    const bars = MAX_BARS + 44
    const long = { ...HUM, bars, melody: Array.from({ length: bars * 4 }, (_, i) => ({ pitch: 67, start: i * 4, dur: 4, vel: 90 })) }
    const { song, dropped } = applyHumming(songFromMood(getMood('vui')), long, { useKey: true, useBpm: true, autoHarmony: false })
    expect(song.bars).toBe(MAX_BARS)
    expect(dropped).toBe(176)
    expect(Math.max(...song.melody.map((n) => n.start + n.dur))).toBeLessThanOrEqual(MAX_BARS * 16)
  })
})

describe('ngân từng đoạn rồi ghép', () => {
  const first = () => applyHumming(songFromMood(getMood('vui')), HUM, { useKey: true, useBpm: true, autoHarmony: true }).song

  it('đoạn sau nối tiếp sau đoạn trước, giữ hợp âm cũ, dịch về giọng của bài', () => {
    const s1 = first()
    // Đoạn 2 ngân cao hơn 2 nửa cung (giọng La trưởng) so với bài (Sol trưởng).
    const part2 = { ...HUM, tonic: 9, melody: HUM.melody.map((n) => ({ ...n, pitch: n.pitch + 2 })) }
    const { song: s2, dropped } = appendHumming(s1, part2, { autoHarmony: true })
    expect(dropped).toBe(0)
    expect(s2.bars).toBe(8)
    expect(s2.chords).toHaveLength(8)
    expect(s2.chords.slice(0, 4)).toEqual(s1.chords)
    expect(s2.melody).toHaveLength(HUM.melody.length * 2)
    const added = s2.melody.slice(HUM.melody.length)
    expect(added[0].start).toBe(4 * 16)
    expect(added.map((n) => n.pitch)).toEqual(HUM.melody.map((n) => n.pitch))
    expect(validateSong(s2)).toBeNull()
  })

  it('fitShift chọn dịch ít nhất khi đã khớp thang', () => {
    expect(fitShift(HUM, 7, 'major')).toBe(0)
    expect(fitShift({ ...HUM, melody: HUM.melody.map((n) => ({ ...n, pitch: n.pitch - 1 })) }, 7, 'major')).toBe(1)
  })

  it('hoàn thiện thành bài: dạo đầu, đoạn chính, điệp khúc, kết về chủ âm', () => {
    const base = appendHumming(first(), HUM, { autoHarmony: true }).song // 8 ô giai điệu
    const s = arrangeSong(base, 5)
    expect(s.sections?.map((x) => [x.kind, x.start, x.bars])).toEqual([
      ['intro', 0, 4],
      ['verse', 4, 8],
      ['chorus', 12, 8],
      ['outro', 20, 2],
    ])
    expect(s.bars).toBe(22)
    expect(s.chords).toHaveLength(22)
    expect(s.chords[3].degree).toBe(4)
    expect(s.chords.slice(4, 12)).toEqual(base.chords)
    expect(s.chords.at(-1)!.degree).toBe(0)
    expect(validateSong(s)).toBeNull()
    // Dạo đầu không có giai điệu, không trống.
    expect(s.melody.every((n) => n.start >= 4 * 16)).toBe(true)
    const drums = drumHits(s)
    expect(drums.some((h) => h.start < 4 * 16)).toBe(false)
    // Điệp khúc đệm dày hơn đoạn chính.
    const bassIn = (from: number, to: number) => bassNotes(s).filter((n) => n.start >= from * 16 && n.start < to * 16).length
    expect(bassIn(12, 20)).toBeGreaterThan(bassIn(4, 12))
    // Kết bằng chủ âm (Sol), có riser dẫn vào điệp khúc.
    const lastNote = s.melody.reduce((a, b) => (b.start > a.start ? b : a))
    expect(lastNote.pitch % 12).toBe(7)
    expect(lastNote.start).toBe(20 * 16)
    expect(s.fx.some((f) => f.fx === 'riser' && f.start === 11 * 16)).toBe(true)
    expect(canAppend(s)).toBe(false)
  })

  it('kéo dài tới thời lượng mong muốn bằng cách lặp đoạn chính và điệp khúc', () => {
    const base = appendHumming(first(), HUM, { autoHarmony: true }).song // 8 ô, 96 BPM: 1 ô = 2.5 giây
    const s = arrangeSong(base, 5, 180)
    expect(s.sections?.map((x) => x.kind)).toEqual(['intro', 'verse', 'chorus', 'verse', 'chorus', 'verse', 'chorus', 'verse', 'chorus', 'chorus', 'outro'])
    expect(songSeconds(s)).toBeLessThan(180 + 8 * 2.5)
    expect(songSeconds(s)).toBeGreaterThanOrEqual(180)
    expect(validateSong(s)).toBeNull()
    // Các điệp khúc giống nhau.
    const notesIn = (from: number) => s.melody.filter((n) => n.start >= from * 16 && n.start < (from + 8) * 16).map((n) => [n.pitch, n.start - from * 16])
    const choruses = s.sections!.filter((x) => x.kind === 'chorus').map((x) => notesIn(x.start))
    expect(choruses[1]).toEqual(choruses[0])
    expect(formatDuration(songSeconds(s))).toMatch(/^\d+:\d\d$/)
  })

  it('bài quá dài thì không lặp điệp khúc', () => {
    const half = MAX_BARS / 2 // dài quá nửa giới hạn: lặp thêm một lần là vượt MAX_BARS
    const big = applyHumming(songFromMood(getMood('vui')), { ...HUM, bars: half, melody: Array.from({ length: half * 4 }, (_, i) => ({ pitch: 67, start: i * 4, dur: 4, vel: 90 })) }, { useKey: true, useBpm: true, autoHarmony: false }).song
    const s = arrangeSong(big, 1, 600)
    expect(s.sections?.map((x) => x.kind)).toEqual(['intro', 'verse', 'outro'])
    expect(s.bars).toBe(4 + half + 2)
  })
})

describe('đổi độ dài bài', () => {
  it('thêm ô thì lặp vòng hợp âm, bớt ô thì cắt nốt, hiệu ứng và bỏ cấu trúc', () => {
    const base = { ...songFromMood(getMood('vui'), 4), fx: [{ id: 'a', fx: 'riser', start: 60 }] }
    base.chords = [0, 5, 3, 4].map((degree) => ({ degree, seventh: false }))
    const longer = resizeSong(base, 8)
    expect(longer.chords.map((c) => c.degree)).toEqual([0, 5, 3, 4, 0, 5, 3, 4])
    const withNotes = { ...longer, sections: [{ kind: 'verse' as const, start: 0, bars: 8 }], melody: [{ id: 'x', pitch: 60, start: 28, dur: 8, vel: 90 }, { id: 'y', pitch: 62, start: 40, dur: 4, vel: 90 }] }
    const shorter = resizeSong(withNotes, 2)
    expect(shorter.chords).toHaveLength(2)
    expect(shorter.melody).toEqual([{ id: 'x', pitch: 60, start: 28, dur: 4, vel: 90 }])
    expect(shorter.fx).toHaveLength(0)
    expect(shorter.sections).toBeUndefined()
    expect(validateSong(shorter)).toBeNull()
  })
})

describe('timeline kéo dài tự do', () => {
  it('kéo dài bài giữ cấu trúc, ô mới lặp hợp âm của đoạn cuối', () => {
    const base = appendHumming(applyHumming(songFromMood(getMood('vui')), HUM, { useKey: true, useBpm: true, autoHarmony: true }).song, HUM, {
      autoHarmony: true,
    }).song
    const s = arrangeSong(base, 5)
    const longer = extendSong(s, 26)
    expect(longer.bars).toBe(26)
    expect(longer.sections).toEqual(s.sections)
    expect(longer.chords.slice(22).map((c) => c.degree)).toEqual(s.chords.slice(12, 16).map((c) => c.degree))
    expect(extendSong(s, 10)).toBe(s)
    expect(validateSong(longer)).toBeNull()
    expect(contentEndBar(longer)).toBe(22)
  })

  it('thêm một lượt đoạn chính + điệp khúc trước phần kết', () => {
    const base = appendHumming(applyHumming(songFromMood(getMood('vui')), HUM, { useKey: true, useBpm: true, autoHarmony: true }).song, HUM, {
      autoHarmony: true,
    }).song
    const s = arrangeSong(base, 5)
    const more = addRound(s, 9)!
    expect(more.sections?.map((x) => [x.kind, x.start, x.bars])).toEqual([
      ['intro', 0, 4],
      ['verse', 4, 8],
      ['chorus', 12, 8],
      ['verse', 20, 8],
      ['chorus', 28, 8],
      ['outro', 36, 2],
    ])
    expect(more.bars).toBe(38)
    expect(more.chords).toHaveLength(38)
    expect(validateSong(more)).toBeNull()
    const notesIn = (from: number) => more.melody.filter((n) => n.start >= from * 16 && n.start < (from + 8) * 16).map((n) => [n.pitch, n.start - from * 16])
    expect(notesIn(28)).toEqual(notesIn(12))
    expect(new Set(more.melody.map((n) => n.id)).size).toBe(more.melody.length)
    // Nốt kết dời theo phần kết.
    expect(Math.max(...more.melody.map((n) => n.start))).toBe(36 * 16)
    expect(more.fx.some((f) => f.fx === 'riser' && f.start === 27 * 16)).toBe(true)
    expect(addRound(base, 1)).toBeNull()
  })
})
