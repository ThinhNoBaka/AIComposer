import { describe, expect, it } from 'vitest'
import { DEFAULT_LINES, lyricsBefore, lyricsSpec, mergeLyrics } from './aiLyrics'
import { parseLyrics } from './lyrics'
import type { Note } from './song'

const n = (id: string, start: number, pitch: number, dur = 2): Note => ({ id, start, pitch, dur, vel: 0.8 })

describe('viết lời bằng AI', () => {
  it('mỗi câu nhạc là một câu lời, số nốt là số chữ, kèm hướng giai điệu', () => {
    // Câu 1: 3 nốt lên rồi xuống; nghỉ 1 phách; câu 2: 2 nốt.
    const melody = [n('a', 0, 60), n('b', 2, 62), n('c', 4, 61), n('d', 10, 65), n('e', 12, 65)]
    expect(lyricsSpec(melody)).toEqual({ line_syllables: [3, 2], contours: [[2, -1], [0]] })
    expect(lyricsSpec(melody, 1)).toEqual({ line_syllables: [2], contours: [[0]] })
    expect(lyricsSpec(melody, 2).line_syllables).toEqual([])
  })

  it('chưa có giai điệu thì xin 4 câu lục bát', () => {
    expect(lyricsSpec([]).line_syllables).toEqual(DEFAULT_LINES)
  })

  it('ghép lời: viết mới thay hẳn, viết tiếp nối vào cuối', () => {
    expect(mergeLyrics('cũ', ['một', 'hai'], 'new')).toBe('một\nhai')
    expect(mergeLyrics('[Đoạn 1]\ncũ\n\n', ['mới'], 'continue')).toBe('[Đoạn 1]\ncũ\nmới')
    expect(mergeLyrics('', ['mới'], 'continue')).toBe('mới')
    expect(lyricsBefore(parseLyrics('[Điệp khúc]\nem ơi\nnhớ em'))).toBe('em ơi\nnhớ em')
  })
})
