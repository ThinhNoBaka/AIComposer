import type { Chord, Mode } from './theory'

/** Số bước (nốt móc kép) trong một ô nhịp 4/4. */
export const STEPS_PER_BAR = 16

/** Giới hạn số ô nhịp của cả bài. 1024 ô ở 120 BPM là hơn 34 phút. */
export const MAX_BARS = 1024

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
  /** Nốt đã khoá: máy không viết đè, không kéo/xoá được cho tới khi bỏ khoá. */
  locked?: boolean
}

export type TrackId = 'melody' | 'chords' | 'bass' | 'drums'

/** Tên "nhạc cụ" của synth tự chỉnh (không phải sample GM). */
export const CUSTOM_SYNTH = 'custom-synth'

export type SynthWave = 'sine' | 'square' | 'sawtooth' | 'triangle'

/** Âm sắc synth tự chỉnh: dạng sóng, bộ lọc thấp và đường bao ADSR (giây; sustain 0..1). */
export type SynthPreset = {
  wave: SynthWave
  /** Tần số cắt của bộ lọc thông thấp (Hz). */
  cutoff: number
  /** Độ cộng hưởng của bộ lọc. */
  q: number
  attack: number
  decay: number
  sustain: number
  release: number
}

export const DEFAULT_SYNTH: SynthPreset = { wave: 'sawtooth', cutoff: 2400, q: 1, attack: 0.01, decay: 0.2, sustain: 0.6, release: 0.3 }

/** EQ 3 dải, mỗi dải -12..12 dB. */
export type TrackEq = { low: number; mid: number; high: number }

/** Thông số trộn chung của mọi track (kể cả giọng hát). Trường không có = mặc định. */
export type MixSettings = {
  /** 0..1 */
  volume: number
  muted: boolean
  /** -1 (trái) .. 1 (phải), mặc định 0. */
  pan?: number
  /** Mặc định 0 dB cả 3 dải. */
  eq?: TrackEq
  /** Lượng gửi sang tiếng vang 0..1. Không có = mức mặc định của từng track (xem DEFAULT_REVERB). */
  reverb?: number
}

export type Track = MixSettings & {
  /** Tên nhạc cụ GM, CUSTOM_SYNTH, hoặc tên bộ trống với track drums. */
  instrument: string
  /** Âm sắc khi instrument là CUSTOM_SYNTH. */
  synth?: SynthPreset
}

export type VocalVersion = 'original' | 'corrected'

/** Công thức chỉnh cao độ đã dùng (server cũng lưu). */
export type VocalRecipe = {
  strength: number
  mode: 'melody' | 'scale' | 'chromatic'
  retune_speed_ms: number
  keep_vibrato: boolean
}

/** Track giọng hát: một bản thu trên server, đặt vào bài ở mốc offsetMs. */
export type VocalTrack = MixSettings & {
  takeId: string
  version: VocalVersion
  /** Mốc của bài (ms) ứng với đầu bản thu, đã trừ độ trễ ước lượng lúc thu. Có thể âm. */
  offsetMs: number
  /** Bù trễ chỉnh tay (ms): dương = kéo giọng sớm lên. */
  nudgeMs?: number
  recipe?: VocalRecipe
  /** Lần chỉnh gần nhất (để nạp lại bản đã chỉnh khi chỉnh lại). */
  correctedAt?: number
}

/** Mức gửi tiếng vang mặc định, giữ đúng âm thanh của các bài cũ. */
export const DEFAULT_REVERB: Record<TrackId | 'vocal', number> = { melody: 0.5, chords: 0.6, bass: 0, drums: 0.15, vocal: 0.3 }

export function trackPan(t: MixSettings): number {
  return Math.max(-1, Math.min(1, t.pan ?? 0))
}
export function trackEq(t: MixSettings): TrackEq {
  return { low: t.eq?.low ?? 0, mid: t.eq?.mid ?? 0, high: t.eq?.high ?? 0 }
}
export function trackReverb(t: MixSettings, id: TrackId | 'vocal'): number {
  return Math.max(0, Math.min(1, t.reverb ?? DEFAULT_REVERB[id]))
}

/** Mốc bắt đầu thực của giọng trong bài (giây). */
export function vocalOffsetSec(v: VocalTrack): number {
  return (v.offsetMs - (v.nudgeMs ?? 0)) / 1000
}

export type ChordStyle = 'block' | 'pulse' | 'arpeggio' | 'strum'
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
  /** Lời bài hát, mỗi dòng một câu; dòng dạng [Điệp khúc] là nhãn. */
  lyrics?: string
  /** Các phần đang khoá: máy không tự đổi (và giai điệu/lời không sửa tay được). */
  locks?: Locks
  /** Chữ gắn cố định vào từng nốt (id nốt -> âm tiết) khi khoá căn lời. */
  lyricMap?: Record<string, string>
  /** Cách đệm riêng cho từng đoạn (khoá = ô bắt đầu của đoạn), do "Biến tấu bản phối" tạo. */
  sectionStyles?: Record<number, SectionStyle>
  /** Giọng hát đã thu (tab Giọng hát). */
  vocal?: VocalTrack
  /** Trống theo mẫu tay trống thật học từ Groove MIDI ('groove', mặc định) hay mẫu đều như máy ('basic'). */
  drumFeel?: 'groove' | 'basic'
  /** Chọn mẫu trống nào trong các mẫu đã học; "Biến tấu bản phối" đổi số này. Không có thì dùng seed. */
  drumSeed?: number
}

export type Locks = {
  /** Không tạo, biến tấu, ngân đè hay sửa tay giai điệu. */
  melody?: boolean
  /** Không đổi hợp âm đang có (đổi cảm xúc, hoà âm, đổi vòng). Ô mới thêm vẫn được chọn hợp âm. */
  chords?: boolean
  /** Không sửa chữ của lời. */
  lyrics?: boolean
  /** Chữ gắn chặt vào nốt: dời, sửa nốt không làm chữ trượt sang nốt khác. */
  align?: boolean
}

export type SectionStyle = { chordStyle: ChordStyle; drumStyle: DrumStyle }

export const CHORD_STYLES: ChordStyle[] = ['block', 'pulse', 'arpeggio', 'strum']
export const DRUM_STYLES: DrumStyle[] = ['pop', 'ballad', 'lofi', 'dance', 'epic', 'none']

/** Cách đệm hợp âm ở một ô: theo đoạn nếu có biến tấu, không thì theo cả bài. */
export function chordStyleAt(song: Song, bar: number): ChordStyle {
  const sec = sectionAt(song, bar)
  return song.sectionStyles?.[sec ? sec.start : 0]?.chordStyle ?? song.chordStyle
}

export function drumStyleAt(song: Song, bar: number): DrumStyle {
  const sec = sectionAt(song, bar)
  return song.sectionStyles?.[sec ? sec.start : 0]?.drumStyle ?? song.drumStyle
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
  if (typeof s.bars !== 'number' || s.bars < 1 || s.bars > MAX_BARS) return 'Số ô nhịp không hợp lệ.'
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
  if (s.lyrics !== undefined && (typeof s.lyrics !== 'string' || s.lyrics.length > 20000)) return 'Lời bài hát bị hỏng hoặc quá dài.'
  if (s.locks !== undefined && (typeof s.locks !== 'object' || s.locks === null)) return 'Thông tin khoá bị hỏng.'
  if (s.lyricMap !== undefined && (typeof s.lyricMap !== 'object' || s.lyricMap === null || Object.values(s.lyricMap).some((v) => typeof v !== 'string')))
    return 'Thông tin căn lời bị hỏng.'
  if (!s.tracks || !s.tracks.melody || !s.tracks.chords || !s.tracks.bass || !s.tracks.drums) return 'Thiếu thông tin track.'
  if (s.chordStyle !== undefined && !CHORD_STYLES.includes(s.chordStyle)) return 'Kiểu đệm hợp âm không hợp lệ.'
  for (const id of ['melody', 'chords', 'bass', 'drums'] as const) {
    const t = s.tracks[id]
    if (!mixOk(t)) return 'Thông số trộn của track bị hỏng.'
    if (t.synth !== undefined && !synthOk(t.synth)) return 'Âm sắc synth bị hỏng.'
  }
  if (s.sectionStyles !== undefined) {
    if (typeof s.sectionStyles !== 'object' || s.sectionStyles === null) return 'Cách đệm theo đoạn bị hỏng.'
    for (const st of Object.values(s.sectionStyles)) {
      if (!st || !CHORD_STYLES.includes(st.chordStyle) || !DRUM_STYLES.includes(st.drumStyle)) return 'Cách đệm theo đoạn bị hỏng.'
    }
  }
  if (s.drumFeel !== undefined && s.drumFeel !== 'groove' && s.drumFeel !== 'basic') return 'Kiểu cảm giác trống không hợp lệ.'
  if (s.drumSeed !== undefined && !isNum(s.drumSeed)) return 'Thông tin trống bị hỏng.'
  if (s.vocal !== undefined) {
    const v = s.vocal
    if (!v || typeof v.takeId !== 'string' || !v.takeId || (v.version !== 'original' && v.version !== 'corrected')) return 'Track giọng hát bị hỏng.'
    if (!isNum(v.offsetMs) || (v.nudgeMs !== undefined && !isNum(v.nudgeMs)) || !mixOk(v)) return 'Track giọng hát bị hỏng.'
  }
  return null
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const inRange = (x: unknown, lo: number, hi: number) => isNum(x) && x >= lo && x <= hi

function mixOk(t: Partial<MixSettings>): boolean {
  if (!inRange(t.volume, 0, 1) || typeof t.muted !== 'boolean') return false
  if (t.pan !== undefined && !inRange(t.pan, -1, 1)) return false
  if (t.reverb !== undefined && !inRange(t.reverb, 0, 1)) return false
  if (t.eq !== undefined && !(t.eq && inRange(t.eq.low, -12, 12) && inRange(t.eq.mid, -12, 12) && inRange(t.eq.high, -12, 12))) return false
  return true
}

function synthOk(p: Partial<SynthPreset>): boolean {
  return (
    ['sine', 'square', 'sawtooth', 'triangle'].includes(p.wave as string) &&
    inRange(p.cutoff, 20, 20000) &&
    inRange(p.q, 0, 30) &&
    inRange(p.attack, 0, 5) &&
    inRange(p.decay, 0, 5) &&
    inRange(p.sustain, 0, 1) &&
    inRange(p.release, 0, 10)
  )
}
