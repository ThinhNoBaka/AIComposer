import { describe, expect, it } from 'vitest'
import { Midi } from '@tonejs/midi'
import { MOODS, getMood, songFromMood } from './moods'
import { MELODY_HIGH, MELODY_LOW, continueMelody, generateMelody, nextEmptyBar, remapMelody, shiftMelody, varyMelody } from './melody'
import { bassNotes, chordTrackNotes, drumHits, voiceChords } from './accompany'
import { chordFit, chordOptions, harmonize } from './suggest'
import { applySwing, buildEvents } from './events'
import { songToMidi } from './midi'
import { STEPS_PER_BAR, validateSong, type Song } from './song'
import { chordPcs, isInScale } from './theory'

function withMelody(moodId: string, seed = 7): Song {
  const s = songFromMood(getMood(moodId))
  return { ...s, melody: generateMelody(s, { seed }) }
}

describe('giai điệu', () => {
  it.each(MOODS.map((m) => m.id))('mood %s: mọi nốt đúng thang, trong khoảng, không chồng nhau', (id) => {
    for (const seed of [1, 2, 3, 42, 99]) {
      const s = withMelody(id, seed)
      expect(s.melody.length).toBeGreaterThan(s.bars * 2)
      const sorted = [...s.melody].sort((a, b) => a.start - b.start)
      for (let i = 0; i < sorted.length; i++) {
        const n = sorted[i]
        expect(isInScale(n.pitch, s.tonic, s.mode)).toBe(true)
        expect(n.pitch).toBeGreaterThanOrEqual(MELODY_LOW)
        expect(n.pitch).toBeLessThanOrEqual(MELODY_HIGH)
        expect(n.start + n.dur).toBeLessThanOrEqual(s.bars * STEPS_PER_BAR)
        if (i > 0) expect(sorted[i - 1].start + sorted[i - 1].dur).toBeLessThanOrEqual(n.start)
      }
    }
  })

  it('nốt phách mạnh thuộc hợp âm, nốt cuối bài là nốt chủ', () => {
    for (const id of ['vui', 'buon', 'chill', 'dan']) {
      const s = withMelody(id, 5)
      let strong = 0
      let ok = 0
      for (const n of s.melody) {
        if (n.start % 8 !== 0) continue
        strong++
        const bar = Math.floor(n.start / STEPS_PER_BAR)
        if (chordPcs(s.chords[bar], s.tonic, s.mode).includes(n.pitch % 12)) ok++
      }
      expect(ok / strong).toBeGreaterThan(0.85)
      const last = [...s.melody].sort((a, b) => a.start - b.start).at(-1)!
      expect(last.pitch % 12).toBe(s.tonic)
    }
  })

  it.each(MOODS.map((m) => m.id))('mood %s: giai điệu có đường nét, không đứng yên một nốt', (id) => {
    const s = songFromMood(getMood(id))
    for (let seed = 1; seed <= 30; seed++) {
      const ps = generateMelody(s, { seed }).sort((a, b) => a.start - b.start).map((n) => n.pitch)
      expect(Math.max(...ps) - Math.min(...ps)).toBeGreaterThanOrEqual(5)
      let run = 1
      for (let i = 1; i < ps.length; i++) {
        run = ps[i] === ps[i - 1] ? run + 1 : 1
        expect(run).toBeLessThanOrEqual(4)
      }
    }
  })

  it('cùng seed cho cùng giai điệu, khác seed cho giai điệu khác', () => {
    const s = songFromMood(getMood('vui'))
    const a = generateMelody(s, { seed: 11 }).map((n) => [n.pitch, n.start, n.dur])
    const b = generateMelody(s, { seed: 11 }).map((n) => [n.pitch, n.start, n.dur])
    const c = generateMelody(s, { seed: 12 }).map((n) => [n.pitch, n.start, n.dur])
    expect(a).toEqual(b)
    expect(a).not.toEqual(c)
  })

  it('viết tiếp giữ phần đã có và lấp phần sau', () => {
    const s = songFromMood(getMood('buon'))
    const firstHalf = generateMelody(s, { seed: 3, toBar: 4 })
    const s2 = { ...s, melody: firstHalf }
    expect(nextEmptyBar(s2)).toBe(4)
    const full = continueMelody(s2, 9)
    expect(full.slice(0, firstHalf.length)).toEqual(firstHalf)
    expect(full.some((n) => n.start >= 7 * STEPS_PER_BAR)).toBe(true)
  })

  it('biến tấu giữ nốt phách mạnh và vẫn đúng thang', () => {
    const s = withMelody('langman', 4)
    const v = varyMelody(s, 8)
    const strongBefore = s.melody.filter((n) => n.start % 8 === 0).map((n) => [n.start, n.pitch])
    const strongAfter = v.filter((n) => n.start % 8 === 0).map((n) => [n.start, n.pitch])
    expect(strongAfter).toEqual(strongBefore)
    for (const n of v) expect(isInScale(n.pitch, s.tonic, s.mode)).toBe(true)
  })

  it('cao hơn / thấp hơn đi theo bậc trong thang', () => {
    const s = withMelody('vui', 4)
    const up = shiftMelody(s, 1)
    for (const n of up) expect(isInScale(n.pitch, s.tonic, s.mode)).toBe(true)
    expect(shiftMelody({ ...s, melody: up }, -1).map((n) => n.pitch)).toEqual(s.melody.map((n) => n.pitch))
  })

  it('đổi mood chuyển nốt sang thang mới', () => {
    const s = withMelody('vui', 4)
    const out = remapMelody(s.melody, s, { tonic: 9, mode: 'minor' })
    for (const n of out) expect(isInScale(n.pitch, 9, 'minor')).toBe(true)
  })
})

describe('đệm', () => {
  it('thế bấm hợp âm chuyển mượt và nằm trong khoảng', () => {
    const s = songFromMood(getMood('vui'))
    const v = voiceChords(s)
    for (const chord of v) {
      expect(chord[0]).toBeGreaterThanOrEqual(48)
      expect(chord.at(-1)!).toBeLessThanOrEqual(76)
    }
    for (let i = 1; i < v.length; i++) {
      const move = v[i].reduce((a, p, k) => a + Math.abs(p - v[i - 1][Math.min(k, v[i - 1].length - 1)]), 0)
      expect(move).toBeLessThanOrEqual(10)
    }
  })

  it.each(MOODS.map((m) => m.id))('mood %s: hợp âm, bass, trống nằm trong bài với mọi độ dày', (id) => {
    for (const density of [0, 1, 2] as const) {
      const s = { ...songFromMood(getMood(id)), density }
      const end = s.bars * STEPS_PER_BAR
      const chords = chordTrackNotes(s)
      const bass = bassNotes(s)
      expect(chords.length).toBeGreaterThan(0)
      expect(bass.length).toBeGreaterThan(0)
      for (const n of [...chords, ...bass]) {
        expect(n.start).toBeGreaterThanOrEqual(0)
        expect(n.start).toBeLessThan(end)
        expect(n.dur).toBeGreaterThan(0)
      }
      for (const n of bass) {
        expect(n.pitch).toBeGreaterThanOrEqual(28)
        expect(n.pitch).toBeLessThanOrEqual(52)
      }
      for (const h of drumHits(s)) expect(h.start).toBeLessThan(end)
      if (s.drumStyle === 'none') expect(drumHits(s)).toEqual([])
    }
  })

  it('bass chơi nốt gốc của hợp âm ở đầu mỗi ô', () => {
    const s = songFromMood(getMood('buon'))
    const bass = bassNotes(s)
    for (let bar = 0; bar < s.bars; bar++) {
      const first = bass.find((n) => n.start === bar * STEPS_PER_BAR)!
      expect(first.pitch % 12).toBe(chordPcs(s.chords[bar], s.tonic, s.mode)[0])
    }
  })
})

describe('gợi ý hợp âm', () => {
  it('độ hợp cao khi giai điệu toàn nốt hợp âm', () => {
    const s = songFromMood(getMood('vui'))
    const melody = [60, 64, 67, 64].map((p, i) => ({ id: String(i), pitch: p, start: i * 4, dur: 4, vel: 90 }))
    const song = { ...s, melody }
    expect(chordFit(song, 0, { degree: 0, seventh: false })).toBe(1)
    expect(chordFit(song, 0, { degree: 1, seventh: false })).toBeLessThan(0)
  })

  it('phương án thay thế: cùng chức năng trước, không lặp hợp âm hiện tại', () => {
    const s = withMelody('vui', 3)
    const opts = chordOptions(s, 0)
    expect(opts).toHaveLength(6)
    expect(opts.every((o) => o.chord.degree !== s.chords[0].degree)).toBe(true)
    expect(opts[0].sameFunction).toBe(true)
  })

  it('hoà âm theo giai điệu: kết về chủ, sửa được vòng hợp âm sai', () => {
    for (const id of ['vui', 'buon', 'langman']) {
      const s = withMelody(id, 21)
      // Thay vòng hợp âm bằng một hợp âm lặp lại không khớp giai điệu.
      const wrong = { ...s, chords: s.chords.map(() => ({ degree: 1, seventh: false })) }
      const h = harmonize(wrong)
      expect(h).toHaveLength(s.bars)
      expect(h.at(-1)!.degree).toBe(0)
      const fit = (chords: typeof h) => chords.reduce((a, c, i) => a + chordFit({ ...s, chords }, i, c), 0)
      expect(fit(h)).toBeGreaterThan(fit(wrong.chords) + 2)
      expect(fit(h)).toBeGreaterThanOrEqual(fit(s.chords) - 1)
    }
  })
})

describe('sự kiện, swing, MIDI và file', () => {
  it('swing chỉ đẩy nửa sau phách', () => {
    expect(applySwing(0, 0.25)).toBe(0)
    expect(applySwing(2, 0.25)).toBe(2.5)
    expect(applySwing(4, 0.25)).toBe(4)
    expect(applySwing(2, 0)).toBe(2)
  })

  it('tắt track thì không có sự kiện của track đó', () => {
    const s = withMelody('vui')
    const muted = { ...s, tracks: { ...s.tracks, bass: { ...s.tracks.bass, muted: true } } }
    expect(buildEvents(muted).some((e) => e.track === 'bass')).toBe(false)
    expect(buildEvents(s).some((e) => e.track === 'bass')).toBe(true)
    const ev = buildEvents(s)
    for (let i = 1; i < ev.length; i++) expect(ev[i].start).toBeGreaterThanOrEqual(ev[i - 1].start)
  })

  it('file MIDI đọc lại được, đúng tempo, đúng số nốt giai điệu và nhạc cụ', () => {
    const s = withMelody('chill')
    const bytes = songToMidi({ ...s, swing: 0 })
    const back = new Midi(bytes)
    expect(Math.round(back.header.tempos[0].bpm)).toBe(s.bpm)
    expect(back.tracks[0].notes.length).toBe(s.melody.length)
    expect(back.tracks[0].instrument.number).toBe(5) // electric_piano_2
    expect(back.tracks[3].channel).toBe(9)
    const first = [...s.melody].sort((a, b) => a.start - b.start)[0]
    expect(back.tracks[0].notes[0].midi).toBe(first.pitch)
    expect(back.tracks[0].notes[0].ticks).toBe(first.start * (back.header.ppq / 4))
  })

  it('validateSong nhận bài hợp lệ, từ chối file hỏng', () => {
    const s = withMelody('vui')
    expect(validateSong(JSON.parse(JSON.stringify(s)))).toBeNull()
    expect(validateSong({})).not.toBeNull()
    expect(validateSong({ ...s, chords: [] })).not.toBeNull()
    expect(validateSong({ ...s, melody: [{ pitch: 60, start: 0, dur: 0 }] })).not.toBeNull()
  })
})
