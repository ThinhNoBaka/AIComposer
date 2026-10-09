import type { Chord, Mode } from './theory'

/** Số bước (nốt móc kép) trong một ô nhịp 4/4. */
export const STEPS_PER_BAR = 16

export type Note = {
  id: string
  /** Cao độ MIDI. */
  pitch: number
  /** Vị trí bắt đầu, tính bằng bước 1/16 kể từ đầu bài. */
  start: number
  /** Độ dài, tính bằng bước. */
  dur: number
  /** Lực đánh 1..127. */
  vel: number
}

export type TrackId = 'melody' | 'chords' | 'bass' | 'drums'

export type Track = {
  /** Tên nhạc cụ GM, hoặc tên bộ trống với track drums. */
  instrument: string
  /** 0..1 */
  volume: number
  muted: boolean
}

export type ChordStyle = 'block' | 'pulse' | 'arpeggio'
export type DrumStyle = 'pop' | 'ballad' | 'lofi' | 'dance' | 'epic' | 'none'

export type FxEvent = {
  id: string
  /** Mã hiệu ứng trong thư viện FX. */
  fx: string
  /** Vị trí bằng bước. */
  start: number
}

export type SectionKind = 'intro' | 'verse' | 'chorus' | 'outro'

/** Một phần của bài, tính bằng ô nhịp. */
export type Section = { kind: SectionKind; start: number; bars: number }

export const SECTION_LABEL: Record<SectionKind, string> = {
  intro: 'Dạo đầu',
  verse: 'Đoạn chính',
  chorus: 'Điệp khúc',
  outro: 'Kết',
}

export type Song = {
  version: 1
  title: string
  moodId: string
  tonic: number
  mode: Mode
  bpm: number
  bars: number
  /** Một hợp âm cho mỗi ô nhịp. */
  chords: Chord[]
  melody: Note[]
  tracks: Record<TrackId, Track>
  chordStyle: ChordStyle
  drumStyle: DrumStyle
  /** 0 = thưa, 1 = vừa, 2 = dày. */
  density: 0 | 1 | 2
  /** Độ swing 0..0.5 (lo-fi, jazz). */
  swing: number
  fx: FxEvent[]
  fxVolume: number
  seed: number
  /** Cấu trúc bài sau khi bấm "Hoàn thiện thành bài". Không có = cả bài là một đoạn. */
  sections?: Section[]
}

let counter = 0
export function newId(prefix = 'n'): string {
  counter += 1
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`
}

export function sectionAt(song: Song, bar: number): Section | undefined {
  return song.sections?.find((x) => bar >= x.start && bar < x.start + x.bars)
}

/** Độ dày phần đệm ở từng ô: dạo đầu và kết thưa, điệp khúc dày hơn đoạn chính một bậc. */
export function densityAt(song: Song, bar: number): 0 | 1 | 2 {
  const kind = sectionAt(song, bar)?.kind
  if (kind === 'intro' || kind === 'outro') return 0
  if (kind === 'chorus') return Math.min(2, song.density + 1) as 0 | 1 | 2
  return song.density
}

export function songSteps(song: Song): number {
  return song.bars * STEPS_PER_BAR
}

export function stepSeconds(bpm: number): number {
  return 60 / bpm / 4
}

/** Kiểm tra Song nhập từ file: trả về thông báo lỗi tiếng Việt, hoặc null nếu hợp lệ. */
export function validateSong(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return 'File không phải dữ liệu bài nhạc.'
  const s = raw as Partial<Song>
  if (s.version !== 1) return 'Phiên bản file không được hỗ trợ.'
  if (typeof s.bpm !== 'number' || s.bpm < 40 || s.bpm > 220) return 'Tempo phải trong khoảng 40–220 BPM.'
  if (typeof s.bars !== 'number' || s.bars < 1 || s.bars > 128) return 'Số ô nhịp không hợp lệ.'
  if (!Array.isArray(s.chords) || s.chords.length !== s.bars) return 'Số hợp âm phải bằng số ô nhịp.'
  if (!Array.isArray(s.melody)) return 'Thiếu giai điệu.'
  for (const n of s.melody) {
    if (typeof n.pitch !== 'number' || typeof n.start !== 'number' || typeof n.dur !== 'number' || n.dur <= 0) {
      return 'Có nốt nhạc bị hỏng trong file.'
    }
  }
  if (s.sections !== undefined) {
    if (!Array.isArray(s.sections)) return 'Cấu trúc bài bị hỏng.'
    for (const x of s.sections) {
      if (!(x.kind in SECTION_LABEL) || x.start < 0 || x.bars < 1 || x.start + x.bars > s.bars) return 'Cấu trúc bài bị hỏng.'
    }
  }
  if (!s.tracks || !s.tracks.melody || !s.tracks.chords || !s.tracks.bass || !s.tracks.drums) return 'Thiếu thông tin track.'
  return null
}
