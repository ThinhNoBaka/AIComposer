import { describe, expect, it } from 'vitest'
import {
  chordFunction,
  chordName,
  chordPitches,
  degreeToMidi,
  isInScale,
  midiToDegree,
  midiToName,
  snapToScale,
} from './theory'
import { GM_INSTRUMENTS, gmProgram } from './instruments'
import { getSoundfontNames } from 'smplr'

describe('thang âm và bậc', () => {
  it('degreeToMidi và midiToDegree là nghịch đảo trên nốt trong thang', () => {
    for (const mode of ['major', 'minor', 'dorian', 'majorPentatonic', 'minorPentatonic'] as const) {
      for (let d = 20; d < 60; d++) {
        const m = degreeToMidi(d, 7, mode)
        expect(midiToDegree(m, 7, mode)).toBe(d)
      }
    }
  })

  it('C major: bậc 35 là C4 (60)', () => {
    expect(degreeToMidi(35, 0, 'major')).toBe(60)
    expect(midiToName(60)).toBe('C4')
  })

  it('snapToScale đưa nốt ngoài thang về nốt trong thang gần nhất', () => {
    expect(snapToScale(61, 0, 'major')).toBe(60) // C# → C (hoà thì lấy bậc thấp)
    expect(snapToScale(70, 0, 'major')).toBe(69) // A# → A
    expect(snapToScale(71, 0, 'major')).toBe(71) // B giữ nguyên
    expect(isInScale(snapToScale(66, 9, 'minor'), 9, 'minor')).toBe(true)
  })

  it('B snap lên C của quãng tám trên khi gần hơn', () => {
    // E minor ngũ cung (E G A B D): C# (61) gần D (62) hơn B (59)
    expect(snapToScale(61, 4, 'minorPentatonic')).toBe(62)
  })
})

describe('hợp âm', () => {
  it('tên hợp âm trong C major', () => {
    const names = [0, 1, 2, 3, 4, 5, 6].map((d) => chordName({ degree: d, seventh: false }, 0, 'major'))
    expect(names).toEqual(['C', 'Dm', 'Em', 'F', 'G', 'Am', 'Bdim'])
  })

  it('hợp âm 7 trong F major', () => {
    expect(chordName({ degree: 1, seventh: true }, 5, 'major')).toBe('Gm7')
    expect(chordName({ degree: 4, seventh: true }, 5, 'major')).toBe('C7')
    expect(chordName({ degree: 0, seventh: true }, 5, 'major')).toBe('Fmaj7')
  })

  it('A minor: Am F C G', () => {
    expect([0, 5, 2, 6].map((d) => chordName({ degree: d, seventh: false }, 9, 'minor'))).toEqual(['Am', 'F', 'C', 'G'])
  })

  it('ngũ cung dựng hợp âm theo thang 7 nốt', () => {
    expect(chordName({ degree: 3, seventh: false }, 7, 'majorPentatonic')).toBe('C')
    expect(chordPitches({ degree: 0, seventh: false }, 0, 'major', 3)).toEqual([48, 52, 55])
  })

  it('chức năng hợp âm', () => {
    expect(chordFunction(0)).toBe('home')
    expect(chordFunction(3)).toBe('move')
    expect(chordFunction(4)).toBe('tension')
  })
})

describe('nhạc cụ', () => {
  it('đủ 128 nhạc cụ GM và trùng tên với bộ sample của smplr', () => {
    expect(GM_INSTRUMENTS.length).toBe(128)
    const available = new Set(getSoundfontNames())
    const missing = GM_INSTRUMENTS.filter((n) => !available.has(n))
    expect(missing).toEqual([])
    expect(gmProgram('gunshot')).toBe(127)
    expect(gmProgram('violin')).toBe(40)
  })
})
