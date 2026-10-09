// Chuẩn bị yêu cầu "viết lời bằng AI" từ giai điệu đang có, và ghép lời AI trả về vào lời hiện tại.
// Mỗi câu nhạc (melodyPhrases) là một câu lời; số nốt của câu nhạc là số chữ cần viết.

import { melodyPhrases, type LyricLine } from './lyrics'
import type { Note } from './song'

export const MAX_AI_LINES = 24
/** Chưa có giai điệu: xin 4 câu theo nhịp lục bát quen tai. */
export const DEFAULT_LINES = [6, 8, 6, 8]

export type LyricsSpec = { line_syllables: number[]; contours?: number[][] }

/** Số chữ và hướng giai điệu của từng câu nhạc, bỏ qua `skip` câu đầu (đã có lời). */
export function lyricsSpec(melody: Note[], skip = 0): LyricsSpec {
  const phrases = melodyPhrases(melody).slice(skip, skip + MAX_AI_LINES)
  if (!phrases.length) return skip ? { line_syllables: [] } : { line_syllables: DEFAULT_LINES }
  return {
    line_syllables: phrases.map((p) => Math.min(24, p.length)),
    contours: phrases.map((p) => p.slice(1, 24).map((n, i) => n.pitch - p[i].pitch)),
  }
}

/** Viết mới thì thay hẳn; viết tiếp thì nối vào cuối lời đang có. */
export function mergeLyrics(text: string, lines: string[], mode: 'new' | 'continue'): string {
  const add = lines.join('\n')
  if (mode === 'new' || !text.trim()) return add
  return `${text.replace(/\s+$/, '')}\n${add}`
}

/** Lời đang có, bỏ nhãn đoạn, để AI viết tiếp cho liền ý. */
export const lyricsBefore = (lines: LyricLine[]) => lines.map((l) => l.text).join('\n')
