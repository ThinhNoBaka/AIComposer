import { describe, expect, it } from 'vitest'
import {
  alignLyrics,
  fixToneHint,
  isBang,
  melodyFromLyrics,
  melodyPhrases,
  parseLyrics,
  rhymeOf,
  rhymeScheme,
  rhymeSuggestions,
  splitNotesForLyrics,
  toneOf,
  withTone,
} from './lyrics'
import { getMood, songFromMood } from './moods'
import { isInScale } from './theory'
import type { Note } from './song'

const note = (id: string, pitch: number, start: number, dur = 2): Note => ({ id, pitch, start, dur, vel: 90 })

describe('thanh điệu', () => {
  it('nhận đúng 6 thanh, kể cả chữ gõ kiểu tổ hợp (NFD)', () => {
    expect(['ma', 'mà', 'má', 'mả', 'mã', 'mạ'].map(toneOf)).toEqual(['ngang', 'huyen', 'sac', 'hoi', 'nga', 'nang'])
    expect(toneOf('người'.normalize('NFD'))).toBe('huyen')
    expect(toneOf('Thương,')).toBe('ngang')
    expect(isBang(toneOf('yêu'))).toBe(true)
    expect(isBang(toneOf('nhớ'))).toBe(false)
  })

  it('đổi thanh đặt dấu đúng chỗ', () => {
    expect(withTone('mà', 'sac')).toBe('má')
    expect(withTone('hoa', 'huyen')).toBe('hòa')
    expect(withTone('người', 'sac')).toBe('ngưới')
    expect(withTone('toan', 'sac')).toBe('toán')
    expect(withTone('gì', 'ngang')).toBe('gi')
    expect(withTone('Yêu!', 'nang')).toBe('yệu')
  })

  it('tìm vần bỏ âm đệm và dấu thanh', () => {
    expect(rhymeOf('hoa')).toBe('a')
    expect(rhymeOf('ca')).toBe('a')
    expect(rhymeOf('mưa')).toBe(rhymeOf('xưa'))
    expect(rhymeOf('thương')).toBe(rhymeOf('đường'))
    expect(rhymeOf('tuần')).toBe('ân')
    expect(rhymeOf('quá')).toBe('a')
    expect(rhymeOf('123')).toBeNull()
  })
})

describe('tách lời', () => {
  it('bỏ dòng trống, giữ nhãn [..] cho câu sau, tách âm tiết theo khoảng trắng', () => {
    const lines = parseLyrics('[Đoạn 1]\nEm ơi, Hà Nội phố\n\n  ta còn em  \n[Điệp khúc]\nmùi hoàng lan')
    expect(lines.map((l) => l.syllables.length)).toEqual([5, 3, 3])
    expect(lines[0].label).toBe('Đoạn 1')
    expect(lines[1].label).toBeUndefined()
    expect(lines[2].label).toBe('Điệp khúc')
    expect(lines[0].syllables[1]).toBe('ơi,')
  })
})

describe('gắn lời vào nốt', () => {
  const melody = [note('a', 64, 0), note('b', 67, 2), note('c', 69, 4, 8), note('d', 67, 16), note('e', 64, 18)]

  it('chia câu nhạc ở chỗ lặng hoặc nốt ngân dài', () => {
    expect(melodyPhrases(melody).map((p) => p.map((n) => n.id).join(''))).toEqual(['abc', 'de'])
  })

  it('gắn chữ theo câu, báo câu thiếu nốt và chữ ngân qua nhiều nốt', () => {
    const al = alignLyrics(parseLyrics('em đi xa\nnhớ'), melody)
    expect(al.syllableOf.get('a')).toBe('em')
    expect(al.syllableOf.get('c')).toBe('xa')
    expect(al.syllableOf.get('d')).toBe('nhớ')
    expect(al.syllableOf.get('e')).toBe('–')
    expect(al.lines.map((l) => l.notes)).toEqual([3, 2])
    expect(al.freePhrases).toBe(0)
  })

  it('cảnh báo chữ thanh huyền mà giai điệu nhảy lên, và sửa được', () => {
    const song = { ...songFromMood(getMood('vui')), tonic: 0, mode: 'major' as const, melody: [note('a', 64, 0), note('b', 71, 2)] }
    const al = alignLyrics(parseLyrics('em về'), song.melody)
    expect(al.hints).toHaveLength(1)
    expect(al.hints[0]).toMatchObject({ noteId: 'b', went: 'up', heard: 'vê', fix: 'lower' })
    const fixed = fixToneHint(song, al.hints[0])
    expect(fixed.find((n) => n.id === 'b')!.pitch).toBeLessThan(64)
    expect(alignLyrics(parseLyrics('em về'), fixed).hints).toHaveLength(0)
  })

  it('không cảnh báo khi giai điệu đi đúng hướng thanh', () => {
    const al = alignLyrics(parseLyrics('em nhớ'), [note('a', 64, 0), note('b', 69, 2)])
    expect(al.hints).toHaveLength(0)
  })

  it('chẻ nốt dài cho đủ chữ', () => {
    const song = { ...songFromMood(getMood('vui')), melody: [note('a', 64, 0, 6), note('b', 67, 6, 6)] }
    const lines = parseLyrics('một hai ba bốn')
    const { melody: out, added } = splitNotesForLyrics(song, lines)
    expect(added).toBe(2)
    expect(out).toHaveLength(4)
    expect(out.reduce((s, n) => s + n.dur, 0)).toBe(12)
    expect(out.map((n) => n.start)).toEqual([0, 3, 6, 9])
    expect(alignLyrics(lines, out).lines[0].notes).toBe(4)
  })
})

describe('vần', () => {
  it('đánh nhóm vần cho chữ cuối câu', () => {
    const r = rhymeScheme(parseLyrics('chiều nay mưa\nnhớ ngày xưa\nem đi xa'))
    expect(r.map((x) => x.group)).toEqual(['A', 'A', null])
    expect(r[2].word).toBe('xa')
  })

  it('gợi ý chữ cùng vần, thanh bằng trước', () => {
    const s = rhymeSuggestions('thương')
    expect(s.length).toBeGreaterThan(2)
    expect(s.every((x) => rhymeOf(x.word) === rhymeOf('thương'))).toBe(true)
    expect(s.some((x) => x.word === 'thương')).toBe(false)
    expect(s[0].bang).toBe(true)
  })
})

describe('giai điệu theo lời', () => {
  it('mỗi chữ một nốt, trong thang âm, đi theo hướng thanh điệu', () => {
    const song = songFromMood(getMood('vui'))
    const lines = parseLyrics('em đi trên con đường nhỏ\nchiều mưa rơi nhẹ bay')
    const { melody, bars, starts } = melodyFromLyrics(song, lines, 7)
    expect(melody).toHaveLength(lines[0].syllables.length + lines[1].syllables.length)
    expect(bars).toBe(4)
    expect(starts).toEqual([0, 32])
    expect(melody.every((n) => isInScale(n.pitch, song.tonic, song.mode))).toBe(true)
    // Gắn lại lời vào giai điệu vừa sinh: đủ nốt cho từng câu.
    const al = alignLyrics(lines, melody)
    expect(al.lines.map((l) => l.notes)).toEqual([6, 5])
    expect(al.hints.length).toBeLessThanOrEqual(1)
  })
})
