import { describe, expect, it } from 'vitest'
import { getMood, songFromMood } from './moods'
import { generateMelody } from './melody'
import { HARMONY_MODEL, barFit, barHistogram, modelFor, viterbi, type HarmonyModelData } from './harmonyModel'
import { chordOptions, harmonize, harmonizeByRules, melodyFit } from './suggest'
import { STEPS_PER_BAR, type Note, type Song } from './song'
import { NO_CHORD } from './theory'

function notes(pitches: number[], bar = 0, dur = 4): Note[] {
  return pitches.map((p, i) => ({ id: `${bar}-${i}`, pitch: p, start: bar * STEPS_PER_BAR + i * dur, dur, vel: 90 }))
}

/** Bài Đô trưởng, 4 ô, ô 0 là C-E-G-E. */
function cMajorSong(): Song {
  const s = songFromMood(getMood('vui'))
  return { ...s, tonic: 0, mode: 'major', bars: 4, chords: s.chords.slice(0, 4), melody: notes([60, 64, 67, 64]) }
}

describe('mô hình hoà âm POP909', () => {
  it('file mô hình có đủ trưởng và thứ, mỗi hàng xác suất cộng lại bằng 1', () => {
    expect(HARMONY_MODEL.source).toBe('POP909')
    for (const mode of ['major', 'minor'] as const) {
      const t = HARMONY_MODEL.modes[mode]!
      const sum = (r: number[]) => r.reduce((a, b) => a + b, 0)
      expect(sum(t.start)).toBeCloseTo(1, 2)
      for (const r of t.trans) expect(sum(r)).toBeCloseTo(1, 2)
      for (const r of t.emit) {
        expect(r).toHaveLength(12)
        expect(sum(r)).toBeCloseTo(1, 2)
      }
    }
  })

  it('histogram ô nhịp tính theo phách, so với nốt chủ', () => {
    const s = { ...cMajorSong(), tonic: 7 } // giọng Sol: C là bậc 4 (5 nửa cung)
    const h = barHistogram(s, 0)
    expect(h.reduce((a, b) => a + b, 0)).toBe(4)
    expect(h[5]).toBe(1) // C
    expect(h[9]).toBe(2) // E
    expect(h[0]).toBe(1) // G
    expect(barHistogram(s, 1).every((x) => x === 0)).toBe(true)
  })

  it('ô C-E-G: bậc I được xếp đầu, độ hợp trong -1..1, ô không nốt là 0', () => {
    const s = cMajorSong()
    const model = modelFor('major')!
    const h = barHistogram(s, 0)
    const fits = [0, 1, 2, 3, 4, 5, 6].map((d) => barFit(model, h, d))
    expect(fits.indexOf(Math.max(...fits))).toBe(0)
    expect(fits[0]).toBeGreaterThan(0.7)
    for (const f of fits) {
      expect(f).toBeGreaterThanOrEqual(-1)
      expect(f).toBeLessThanOrEqual(1)
    }
    expect(fits[1]).toBeLessThan(0)
    expect(melodyFit(s, 0, { degree: 0, seventh: false })).toBeCloseTo(fits[0])
    expect(melodyFit(s, 1, { degree: 0, seventh: false })).toBe(0)
    // Đang là vi (cùng chức năng "ổn định" với I): phương án đầu tiên là I.
    const opts = chordOptions({ ...s, chords: s.chords.map((c, i) => (i === 0 ? { degree: 5, seventh: false } : c)) }, 0)
    expect(opts[0].chord.degree).toBe(0)
    expect(opts[0].fit).toBeCloseTo(fits[0])
  })

  it('Viterbi trả đúng số ô, mỗi ô một bậc 0..6', () => {
    const model = modelFor('minor')!
    const s = { ...songFromMood(getMood('buon')) }
    const song = { ...s, melody: generateMelody(s, { seed: 4 }) }
    const hists = Array.from({ length: song.bars }, (_, b) => barHistogram(song, b))
    const path = viterbi(model, hists)
    expect(path).toHaveLength(song.bars)
    expect(path.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)).toBe(true)
    expect(viterbi(model, [])).toEqual([])
    const h = harmonize(song)
    expect(h).toHaveLength(song.bars)
    expect(h.at(-1)!.degree).toBe(0)
  })

  it('giai điệu V-V-I: Viterbi chọn bậc V rồi về I', () => {
    const s = cMajorSong()
    const melody = [...notes([67, 71, 74, 71], 0), ...notes([62, 67, 71, 74], 1), ...notes([60, 64, 67, 72], 2), ...notes([72, 67, 64, 60], 3)]
    const h = harmonize({ ...s, melody, chords: s.chords.map(() => ({ ...NO_CHORD })) })
    expect(h.map((c) => c.degree)).toEqual([4, 4, 0, 0])
  })

  it('ô trống (bậc -1) có nốt vẫn được chọn hợp âm; ô không nốt giữ hợp âm cũ', () => {
    const s = songFromMood(getMood('vui'))
    const song = { ...s, chords: s.chords.map(() => ({ ...NO_CHORD })), melody: generateMelody(s, { seed: 2 }) }
    expect(harmonize(song).every((c) => c.degree >= 0)).toBe(true)
    // Không có giai điệu: giữ nguyên vòng hợp âm cũ (trừ ô cuối có thể về I).
    const silent = { ...s, melody: [] }
    const h = harmonize(silent)
    expect(h.slice(0, -1).map((c) => c.degree)).toEqual(s.chords.slice(0, -1).map((c) => c.degree))
  })

  it('không có mô hình cho giọng của bài thì dùng luật cũ', () => {
    const partial: HarmonyModelData = { version: 1, source: 'POP909', modes: { major: HARMONY_MODEL.modes.major } }
    expect(modelFor('major', partial)).not.toBeNull()
    expect(modelFor('minor', partial)).toBeNull()
    expect(modelFor('minorPentatonic', partial)).toBeNull()
    expect(modelFor('dorian')).toBeNull()
    expect(modelFor('majorPentatonic')).not.toBeNull()
    const broken = { version: 1, source: 'x', modes: { major: { start: [1], trans: [], emit: [] } } } as HarmonyModelData
    expect(modelFor('major', broken)).toBeNull()
    // Dorian: harmonize trùng với bản luật.
    const s = songFromMood(getMood('mo'))
    const song = { ...s, melody: generateMelody(s, { seed: 9 }) }
    expect(song.mode).toBe('dorian')
    expect(harmonize(song)).toEqual(harmonizeByRules(song))
  })
})
