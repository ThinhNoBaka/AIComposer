// Ô "Bảo máy làm gì": hiểu câu lệnh tiếng Việt ngắn bằng luật (không cần mô hình ngôn ngữ).
// Gõ có dấu hay không dấu đều được: so khớp trên chữ đã bỏ dấu.

import { MOODS, NO_MOOD } from './moods'
import type { TrackId } from './song'
import { NOTE_NAMES, type Mode } from './theory'

export type Command =
  | { kind: 'tempo'; bpm?: number; delta?: number }
  | { kind: 'mood'; moodId: string }
  | { kind: 'key'; tonic: number; mode: Mode }
  | { kind: 'transpose'; semitones: number }
  | { kind: 'arrange' }
  | { kind: 'varyArrangement' }
  | { kind: 'addRound' }
  | { kind: 'extend'; bars: number }
  | { kind: 'melody'; action: 'new' | 'vary' | 'continue' | 'up' | 'down' | 'clear' }
  | { kind: 'chords'; action: 'harmonize' | 'next' | 'sevenths' }
  | { kind: 'instrument'; track: Exclude<TrackId, 'drums'>; instrument: string; label: string }
  | { kind: 'drums'; on: boolean }
  | { kind: 'volume'; track: TrackId; delta: number }
  | { kind: 'transport'; action: 'play' | 'stop' }
  | { kind: 'metronome'; on: boolean }
  | { kind: 'loop'; on: boolean }

export type ParseResult = { commands: Command[]; unknown: string[] }

/** Bỏ dấu tiếng Việt, chữ thường, gộp khoảng trắng. */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

const MOOD_WORDS: Record<string, string> = {
  vui: 'vui( tuoi| ve)?',
  buon: 'buon|sau lang|tram',
  chill: 'chill|lo-?fi|thu gian',
  hung: 'hao hung|hung trang|manh me',
  langman: 'lang man|tinh cam|ngot ngao',
  soi: 'soi dong|quay|nhay',
  mo: 'mo mang|mong mo|ao mong',
  dan: 'dan gian|dan ca|que huong',
}

const SOLFEGE: Record<string, number> = { do: 0, re: 2, mi: 4, fa: 5, son: 7, sol: 7, la: 9, si: 11 }
const LETTER: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }

const NUM_WORDS: Record<string, number> = { mot: 1, hai: 2, ba: 3, bon: 4, nam: 5, sau: 6, bay: 7, tam: 8, chin: 9, muoi: 10 }
const num = (w: string) => (/^\d+$/.test(w) ? Number(w) : NUM_WORDS[w])

const INSTRUMENTS: [RegExp, string, string][] = [
  [/guitar dien|ghi ?ta dien/, 'electric_guitar_clean', 'guitar điện'],
  [/piano dien/, 'electric_piano_1', 'piano điện'],
  [/piano|duong cam/, 'acoustic_grand_piano', 'piano'],
  [/guitar|ghi ?ta/, 'acoustic_guitar_nylon', 'guitar'],
  [/violin|vi ?o ?lon/, 'violin', 'violin'],
  [/cello/, 'cello', 'cello'],
  [/sao truc|sao mui/, 'pan_flute', 'sáo trúc'],
  [/sao|flute/, 'flute', 'sáo'],
  [/sax|saxophone/, 'alto_sax', 'saxophone'],
  [/ken harmonica|harmonica/, 'harmonica', 'harmonica'],
  [/trumpet|ken trom/, 'trumpet', 'trumpet'],
  [/organ/, 'drawbar_organ', 'organ'],
  [/phong cam|accordion/, 'accordion', 'accordion'],
  [/dan tranh|koto/, 'koto', 'đàn tranh'],
  [/dan hac|harp/, 'orchestral_harp', 'đàn hạc'],
  [/dan day|strings/, 'string_ensemble_1', 'dàn dây'],
  [/hop xuong|choir/, 'choir_aahs', 'hợp xướng'],
  [/hop nhac|music box/, 'music_box', 'hộp nhạc'],
  [/marimba/, 'marimba', 'marimba'],
  [/kalimba/, 'kalimba', 'kalimba'],
  [/synth/, 'lead_2_sawtooth', 'synth'],
]

function trackOf(c: string): TrackId | null {
  if (/giai dieu|melody|lead/.test(c)) return 'melody'
  if (/hop am|dem|chord/.test(c)) return 'chords'
  if (/\bbass\b|tram/.test(c)) return 'bass'
  if (/\btrong\b|drum/.test(c)) return 'drums'
  return null
}

function parseKey(c: string): { tonic: number; mode: Mode } | null {
  const m =
    c.match(/(?:giong|tong|key|sang|ve)\s+(do|re|mi|fa|son|sol|la|si|[a-g])(?!m[a-z])(?![a-ln-z])(\s*(?:#|thang|b\b|giang))?\s*(truong|thu|major|minor|m\b)?/) ??
    c.match(/^(do|re|mi|fa|son|sol|la|si|[a-g])(\s*(?:#|thang|b\b|giang))?\s*(truong|thu|major|minor|m\b)$/)
  if (!m) return null
  let tonic = SOLFEGE[m[1]] ?? LETTER[m[1]]
  if (m[2]) tonic += /#|thang/.test(m[2]) ? 1 : -1
  const mode: Mode = m[3] && /thu|minor|^m$/.test(m[3]) ? 'minor' : 'major'
  return { tonic: (tonic + 12) % 12, mode }
}

function parseClause(c: string): Command[] {
  const out: Command[] = []
  // Tempo
  const bpm = c.match(/(?:tempo|toc do|nhip|bpm)\s*(\d{2,3})/) ?? c.match(/(\d{2,3})\s*bpm/)
  if (bpm) out.push({ kind: 'tempo', bpm: Number(bpm[1]) })
  else if (/nhanh (hon|len)|tang toc|nhanh nua/.test(c)) out.push({ kind: 'tempo', delta: /\b(nhieu|han)\b/.test(c) ? 20 : /\b(chut|it)\b/.test(c) ? 5 : 10 })
  else if (/cham (hon|lai|xuong)|giam toc|cham nua/.test(c)) out.push({ kind: 'tempo', delta: /\b(nhieu|han)\b/.test(c) ? -20 : /\b(chut|it)\b/.test(c) ? -5 : -10 })

  // Giọng và dịch giọng
  const key = parseKey(c)
  if (key) out.push({ kind: 'key', ...key })
  const tr = c.match(/(len|tang|nang|cao len|ha|giam|xuong|thap xuong)\s*(\d+|mot|hai|ba|bon|nam|sau|nua)?\s*(nua cung|cung)\b/)
  if (tr && !/giai dieu|not/.test(c)) {
    const n = tr[2] === 'nua' ? 1 : (num(tr[2] ?? 'mot') ?? 1) * (tr[3] === 'cung' ? 2 : 1)
    out.push({ kind: 'transpose', semitones: /ha|giam|xuong/.test(tr[1]) ? -n : n })
  }

  // Cảm xúc, ô trống
  if (/bo trong|de trong|o trong|xoa (het )?hop am|khong (co )?cam xuc|bo (chon )?cam xuc/.test(c)) out.push({ kind: 'mood', moodId: NO_MOOD })
  else if (/(doi|chuyen|sang|thanh|cam xuc|kieu|phong cach|nghe|cho)\b/.test(c) || MOODS.some((m) => new RegExp(`^(${MOOD_WORDS[m.id]})$`).test(c))) {
    const mood = MOODS.find((m) => MOOD_WORDS[m.id] && new RegExp(`\\b(${MOOD_WORDS[m.id]})\\b`).test(c))
    if (mood) out.push({ kind: 'mood', moodId: mood.id })
  }

  // Cấu trúc bài
  if (/them (mot )?(diep khuc|luot|doan)/.test(c)) out.push({ kind: 'addRound' })
  else if (/hoan thien|thanh (ca )?bai|phoi (thanh|ca) bai/.test(c)) out.push({ kind: 'arrange' })
  const ext = c.match(/(?:dai them|them|keo dai)\s*(\d+|mot|hai|ba|bon|nam|sau|bay|tam)\s*o/)
  if (ext) out.push({ kind: 'extend', bars: num(ext[1]) ?? 4 })

  // Giai điệu
  if (/xoa giai dieu/.test(c)) out.push({ kind: 'melody', action: 'clear' })
  else if (/(tao|viet|lam|doi) (giai dieu|nhac)( moi| khac)?|giai dieu (moi|khac)/.test(c) && !/viet tiep/.test(c)) out.push({ kind: 'melody', action: 'new' })
  else if (/viet tiep|noi tiep/.test(c)) out.push({ kind: 'melody', action: 'continue' })
  else if (/bien tau/.test(c) && /phoi|dem|trong/.test(c)) out.push({ kind: 'varyArrangement' })
  else if (/bien tau/.test(c)) out.push({ kind: 'melody', action: 'vary' })
  else if (/(giai dieu|not).*(cao (hon|len)|len)|cao giai dieu/.test(c)) out.push({ kind: 'melody', action: 'up' })
  else if (/(giai dieu|not).*(thap (hon|xuong)|xuong)/.test(c)) out.push({ kind: 'melody', action: 'down' })

  // Hợp âm
  if (/hop am mau|hop am (bay|7)|them (not )?bay/.test(c)) out.push({ kind: 'chords', action: 'sevenths' })
  else if (/hop am theo giai dieu|tu (chon|dat) hop am|hoa am lai|hoa am/.test(c)) out.push({ kind: 'chords', action: 'harmonize' })
  else if (/(doi|vong) (vong )?hop am|hop am khac/.test(c) && !INSTRUMENTS.some(([re]) => re.test(c))) out.push({ kind: 'chords', action: 'next' })

  // Nhạc cụ
  const inst = INSTRUMENTS.find(([re]) => re.test(c))
  if (inst && (/nhac cu|tieng|dan|doi|dung|sang|thanh|bang|choi/.test(c) || c === inst[2] || inst[0].test(c.replace(/^(cho )?/, '')))) {
    const t = trackOf(c.replace(inst[0], ''))
    out.push({ kind: 'instrument', track: t === 'chords' || t === 'bass' ? t : 'melody', instrument: inst[1], label: inst[2] })
  }

  // Trống, âm lượng
  if (/(tat|bo tieng|khong co|khong can) (tieng )?trong\b(?! ?(o|nhip))/.test(c)) out.push({ kind: 'drums', on: false })
  else if (/(bat|them|co|mo) (tieng )?trong\b(?! ?(o|nhip))/.test(c)) out.push({ kind: 'drums', on: true })
  if (/(to|lon) (hon|len)|tang am luong/.test(c)) out.push({ kind: 'volume', track: trackOf(c) ?? 'melody', delta: 0.15 })
  else if (/(nho|be) (hon|lai|xuong)|giam am luong/.test(c)) out.push({ kind: 'volume', track: trackOf(c) ?? 'melody', delta: -0.15 })

  // Phát, đếm nhịp, lặp
  if (/(tat|bo) (may )?dem nhip/.test(c)) out.push({ kind: 'metronome', on: false })
  else if (/dem nhip|may dem/.test(c)) out.push({ kind: 'metronome', on: true })
  if (/(tat|bo|thoi) lap/.test(c)) out.push({ kind: 'loop', on: false })
  else if (/lap lai|bat lap|vong lap|^lap$/.test(c)) out.push({ kind: 'loop', on: true })
  if (/^(phat|choi|nghe thu|bat nhac|phat (lai|thu|nhac|tu dau))$/.test(c)) out.push({ kind: 'transport', action: 'play' })
  else if (/^(dung|dung lai|tam dung|ngung|ngung lai|tat nhac)$/.test(c)) out.push({ kind: 'transport', action: 'stop' })
  return out
}

export function parseCommand(text: string): ParseResult {
  const clauses = fold(text)
    .split(/[,;.!?]| va | roi | sau do | xong | them nua /)
    .map((x) => x.trim())
    .filter(Boolean)
  const commands: Command[] = []
  const unknown: string[] = []
  for (const c of clauses) {
    const got = parseClause(c)
    if (got.length) commands.push(...got)
    else unknown.push(c)
  }
  return { commands, unknown }
}

const TRACK_VI: Record<TrackId, string> = { melody: 'giai điệu', chords: 'hợp âm', bass: 'bass', drums: 'trống' }
const MODE_VI: Partial<Record<Mode, string>> = { major: 'trưởng', minor: 'thứ' }
const SOLFEGE_VI = ['Đô', 'Đô thăng', 'Rê', 'Mi giáng', 'Mi', 'Fa', 'Fa thăng', 'Son', 'La giáng', 'La', 'Si giáng', 'Si']

/** Mô tả lệnh bằng tiếng Việt để báo lại cho người dùng máy đã hiểu gì. */
export function describe(cmd: Command): string {
  switch (cmd.kind) {
    case 'tempo':
      return cmd.bpm ? `tempo ${cmd.bpm} BPM` : cmd.delta! > 0 ? `nhanh hơn ${cmd.delta} BPM` : `chậm hơn ${-cmd.delta!} BPM`
    case 'mood':
      return cmd.moodId === NO_MOOD ? 'bỏ cảm xúc, để ô nhịp trống' : `đổi sang ${MOODS.find((m) => m.id === cmd.moodId)?.label.toLowerCase()}`
    case 'key':
      return `giọng ${SOLFEGE_VI[cmd.tonic]} ${MODE_VI[cmd.mode]} (${NOTE_NAMES[cmd.tonic]}${cmd.mode === 'minor' ? 'm' : ''})`
    case 'transpose':
      return `${cmd.semitones > 0 ? 'nâng' : 'hạ'} ${Math.abs(cmd.semitones)} nửa cung`
    case 'arrange':
      return 'hoàn thiện thành bài'
    case 'varyArrangement':
      return 'biến tấu bản phối'
    case 'addRound':
      return 'thêm lượt đoạn chính và điệp khúc'
    case 'extend':
      return `dài thêm ${cmd.bars} ô`
    case 'melody':
      return { new: 'tạo giai điệu mới', vary: 'biến tấu giai điệu', continue: 'viết tiếp giai điệu', up: 'giai điệu cao hơn', down: 'giai điệu thấp hơn', clear: 'xoá giai điệu' }[cmd.action]
    case 'chords':
      return { harmonize: 'chọn hợp âm theo giai điệu', next: 'đổi vòng hợp âm', sevenths: 'bật/tắt hợp âm màu' }[cmd.action]
    case 'instrument':
      return `${TRACK_VI[cmd.track]} dùng ${cmd.label}`
    case 'drums':
      return cmd.on ? 'bật trống' : 'tắt trống'
    case 'volume':
      return `${TRACK_VI[cmd.track]} ${cmd.delta > 0 ? 'to' : 'nhỏ'} hơn`
    case 'transport':
      return cmd.action === 'play' ? 'phát' : 'dừng'
    case 'metronome':
      return cmd.on ? 'bật đếm nhịp' : 'tắt đếm nhịp'
    case 'loop':
      return cmd.on ? 'bật lặp' : 'tắt lặp'
  }
}
