// Hỗ trợ viết lời tiếng Việt: tách âm tiết, gắn chữ vào nốt theo từng câu nhạc,
// cảnh báo chỗ giai điệu đi ngược thanh điệu (hát lên dễ nghe thành chữ khác), tìm vần và gợi ý chữ cùng vần,
// và sinh giai điệu đi theo thanh điệu của lời.

import { createRng } from './rng'
import { melodyRange } from './melody'
import { STEPS_PER_BAR, newId, type Note, type Song } from './song'
import { chordPcs, degreeToMidi, midiToDegree } from './theory'

// ---------- Thanh điệu ----------

export type Tone = 'ngang' | 'huyen' | 'sac' | 'hoi' | 'nga' | 'nang'

export const TONE_LABEL: Record<Tone, string> = {
  ngang: 'ngang',
  huyen: 'huyền',
  sac: 'sắc',
  hoi: 'hỏi',
  nga: 'ngã',
  nang: 'nặng',
}

const TONE_MARK: Record<Exclude<Tone, 'ngang'>, string> = {
  huyen: '̀',
  sac: '́',
  hoi: '̉',
  nga: '̃',
  nang: '̣',
}
const MARK_TONE = new Map(Object.entries(TONE_MARK).map(([t, m]) => [m, t as Tone]))
const TONE_MARKS_RE = /[̣̀́̃̉]/g

/** Độ cao tương đối khi nói: sắc, ngã cao; ngang ở giữa; hỏi, huyền, nặng thấp. */
const TONE_HEIGHT: Record<Tone, number> = { sac: 2, nga: 2, ngang: 1, hoi: 0, huyen: 0, nang: 0 }

/** Chỉ giữ chữ cái, viết thường, dạng NFC. */
export function bareWord(word: string): string {
  return word.normalize('NFC').toLowerCase().replace(/[^\p{L}]/gu, '')
}

export function toneOf(word: string): Tone {
  for (const ch of bareWord(word).normalize('NFD')) {
    const t = MARK_TONE.get(ch)
    if (t) return t
  }
  return 'ngang'
}

/** Thanh bằng (ngang, huyền) hay trắc (sắc, hỏi, ngã, nặng). */
export function isBang(t: Tone): boolean {
  return t === 'ngang' || t === 'huyen'
}

function stripTone(word: string): string {
  return word.normalize('NFD').replace(TONE_MARKS_RE, '').normalize('NFC')
}

const VOWELS = 'aăâeêioôơuưy'
const INITIALS = ['ngh', 'ng', 'nh', 'ch', 'gh', 'gi', 'kh', 'ph', 'qu', 'th', 'tr', 'b', 'c', 'd', 'đ', 'g', 'h', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v', 'x']

type Parts = { initial: string; vowels: string; final: string }

/** Tách âm tiết (đã bỏ dấu thanh, viết thường) thành phụ âm đầu, cụm nguyên âm và âm cuối. */
function splitSyllable(base: string): Parts | null {
  let initial = ''
  for (const c of INITIALS) {
    if (!base.startsWith(c)) continue
    // "gì", "gìn": chữ i là nguyên âm, chỉ có "g" là phụ âm đầu.
    initial = c === 'gi' && !VOWELS.includes(base[2] ?? '') ? 'g' : c
    break
  }
  const rest = base.slice(initial.length)
  let i = 0
  while (i < rest.length && VOWELS.includes(rest[i])) i++
  if (i === 0) return null
  return { initial, vowels: rest.slice(0, i), final: rest.slice(i) }
}

/** Vị trí đặt dấu thanh trong cụm nguyên âm (kiểu bỏ dấu phổ biến: hòa, thủy, toán, muốn). */
function tonePosition(vowels: string, final: string): number {
  let marked = -1
  for (let i = 0; i < vowels.length; i++) if ('ăâêôơư'.includes(vowels[i])) marked = i
  if (marked >= 0) return marked
  if (final) return vowels.length - 1
  return vowels.length === 3 ? 1 : 0
}

/** Đổi thanh của một chữ (dùng để cho thấy chữ đó hát lên nghe giống chữ gì). */
export function withTone(word: string, tone: Tone): string {
  const base = stripTone(bareWord(word))
  const parts = splitSyllable(base)
  if (!parts) return base
  if (tone === 'ngang') return base
  const pos = parts.initial.length + tonePosition(parts.vowels, parts.final)
  return (base.slice(0, pos + 1) + TONE_MARK[tone] + base.slice(pos + 1)).normalize('NFC')
}

/**
 * Vần để so khớp: nguyên âm chính + âm cuối, bỏ dấu thanh và âm đệm (o trong "hoa", u trong "tuần").
 * "hoa" và "ca" cùng vần "a"; "mưa" và "xưa" cùng vần "ưa".
 */
export function rhymeOf(word: string): string | null {
  const parts = splitSyllable(stripTone(bareWord(word)))
  if (!parts) return null
  let v = parts.vowels
  if (v.length >= 2 && ((v[0] === 'o' && 'aăe'.includes(v[1])) || (v[0] === 'u' && 'âêyơ'.includes(v[1])))) v = v.slice(1)
  return v + parts.final
}

// ---------- Tách lời ----------

export type LyricLine = {
  /** Thứ tự câu trong lời (chỉ tính câu có chữ hát). */
  index: number
  text: string
  syllables: string[]
  /** Nhãn đặt trước câu, vd. [Điệp khúc]. */
  label?: string
}

export function parseLyrics(text: string): LyricLine[] {
  const out: LyricLine[] = []
  let label: string | undefined
  for (const raw of text.normalize('NFC').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const tag = /^\[(.+)\]$/.exec(line)
    if (tag) {
      label = tag[1].trim()
      continue
    }
    const syllables = line.split(/[\s\-–—]+/).filter((w) => /[\p{L}\p{N}]/u.test(w))
    if (!syllables.length) continue
    out.push({ index: out.length, text: line, syllables, ...(label ? { label } : {}) })
    label = undefined
  }
  return out
}

// ---------- Câu nhạc ----------

/** Khoảng lặng từ 1 phách trở lên, hoặc nốt ngân từ nửa ô trở lên, là chỗ hết một câu nhạc (chỗ lấy hơi). */
export const PHRASE_GAP = 4
export const PHRASE_HOLD = 8

export function melodyPhrases(melody: Note[]): Note[][] {
  const notes = [...melody].sort((a, b) => a.start - b.start || b.pitch - a.pitch)
  const out: Note[][] = []
  let cur: Note[] = []
  let end = -Infinity
  for (const n of notes) {
    // Nốt chồng lên nốt trước (hai nốt cùng lúc) không tính là chữ mới.
    if (cur.length && n.start < end) continue
    if (cur.length && (n.start - end >= PHRASE_GAP || cur.at(-1)!.dur >= PHRASE_HOLD)) {
      out.push(cur)
      cur = []
    }
    cur.push(n)
    end = n.start + n.dur
  }
  if (cur.length) out.push(cur)
  return out
}

// ---------- Gắn lời vào nốt ----------

export type ToneHint = {
  noteId: string
  line: number
  word: string
  tone: Tone
  /** Giai điệu đi lên hay xuống ở chữ này so với chữ trước. */
  went: 'up' | 'down'
  /** Hát lên dễ nghe thành chữ này. */
  heard: string
  /** Nên dời nốt về hướng nào. */
  fix: 'higher' | 'lower'
  prevPitch: number
}

export type LineFit = {
  line: LyricLine
  notes: number
  /** Bước bắt đầu của câu nhạc gắn với câu lời, không có nếu thiếu nhạc. */
  start?: number
}

export type Alignment = {
  /** Chữ hát trên từng nốt. Nốt ngân tiếp chữ trước có text "–". */
  syllableOf: Map<string, string>
  hints: ToneHint[]
  lines: LineFit[]
  /** Số câu nhạc chưa có lời. */
  freePhrases: number
}

const HEARD_UP: Partial<Record<Tone, Tone>> = { huyen: 'ngang', nang: 'sac', hoi: 'nga', ngang: 'sac' }
const HEARD_DOWN: Partial<Record<Tone, Tone>> = { sac: 'ngang', nga: 'hoi', ngang: 'huyen' }

/** So hướng giai điệu với hướng thanh điệu giữa hai chữ liền nhau. */
function toneHint(prevWord: string, prevNote: Note, word: string, note: Note, line: number): ToneHint | null {
  const a = toneOf(prevWord)
  const b = toneOf(word)
  const want = TONE_HEIGHT[b] - TONE_HEIGHT[a]
  const step = note.pitch - prevNote.pitch
  // Chỉ cảnh báo khi đi ngược hẳn (lệch từ 2 nửa cung). Thanh hỏi uốn lên xuống nên bỏ qua.
  if (b === 'hoi' || Math.abs(step) < 2) return null
  let went: 'up' | 'down'
  if (want < 0 && step > 0) went = 'up'
  else if (want > 0 && step < 0) went = 'down'
  else if (want === 0 && b === 'huyen' && step >= 3) went = 'up'
  else if (want === 0 && (b === 'sac' || b === 'nga') && step <= -3) went = 'down'
  else return null
  const heardTone = (went === 'up' ? HEARD_UP : HEARD_DOWN)[b]
  if (!heardTone) return null
  const heard = withTone(word, heardTone)
  if (heard === bareWord(word)) return null
  return { noteId: note.id, line, word, tone: b, went, heard, fix: went === 'up' ? 'lower' : 'higher', prevPitch: prevNote.pitch }
}

/** Câu lời thứ i đi với câu nhạc thứ i; chữ thứ j đi với nốt thứ j của câu. */
export function alignLyrics(lines: LyricLine[], melody: Note[]): Alignment {
  const phrases = melodyPhrases(melody)
  const syllableOf = new Map<string, string>()
  const hints: ToneHint[] = []
  const fits: LineFit[] = lines.map((line, i) => {
    const notes = phrases[i]
    if (!notes) return { line, notes: 0 }
    notes.forEach((n, j) => {
      const w = line.syllables[j]
      syllableOf.set(n.id, w ?? '–')
      if (w && j > 0) {
        const h = toneHint(line.syllables[j - 1], notes[j - 1], w, n, line.index)
        if (h) hints.push(h)
      }
    })
    return { line, notes: notes.length, start: notes[0].start }
  })
  return { syllableOf, hints, lines: fits, freePhrases: Math.max(0, phrases.length - lines.length) }
}

/** Dời nốt bị cảnh báo một bậc thang âm về phía đúng với thanh điệu (thấp hơn hoặc cao hơn nốt trước). */
export function fixToneHint(song: Song, hint: ToneHint): Note[] {
  const d = midiToDegree(hint.prevPitch, song.tonic, song.mode)
  const pitch = degreeToMidi(hint.fix === 'lower' ? d - 1 : d + 1, song.tonic, song.mode)
  return song.melody.map((n) => (n.id === hint.noteId ? { ...n, pitch } : n))
}

/**
 * Câu nào có nhiều chữ hơn số nốt thì chẻ đôi các nốt dài nhất của câu đó cho đủ chữ.
 * Câu có nhiều nốt hơn chữ thì để nguyên: chữ cuối được ngân qua các nốt còn lại.
 */
export function splitNotesForLyrics(song: Song, lines: LyricLine[]): { melody: Note[]; added: number } {
  const phrases = melodyPhrases(song.melody)
  const replaced = new Map<string, Note[]>()
  let added = 0
  lines.forEach((line, i) => {
    const notes = phrases[i]
    if (!notes) return
    let pieces = notes.map((n) => [n])
    let need = line.syllables.length - notes.length
    while (need > 0) {
      // Chọn mảnh dài nhất còn chẻ được.
      let gi = -1
      let k = -1
      for (let x = 0; x < pieces.length; x++)
        for (let y = 0; y < pieces[x].length; y++) {
          const d = pieces[x][y].dur
          if (d >= 2 && (gi < 0 || d > pieces[gi][k].dur)) {
            gi = x
            k = y
          }
        }
      if (gi < 0) break
      const p = pieces[gi][k]
      const half = Math.floor(p.dur / 2)
      const a = { ...p, dur: half }
      const b = { ...p, id: newId(), start: p.start + half, dur: p.dur - half }
      pieces = pieces.map((g, x) => (x === gi ? [...g.slice(0, k), a, b, ...g.slice(k + 1)] : g))
      need--
      added++
    }
    notes.forEach((n, x) => {
      if (pieces[x].length > 1) replaced.set(n.id, pieces[x])
    })
  })
  const melody = song.melody.flatMap((n) => replaced.get(n.id) ?? [n])
  return { melody, added }
}

// ---------- Vần ----------

export type LineRhyme = { line: number; word: string; rhyme: string | null; bang: boolean; group: string | null }

/** Chữ cuối mỗi câu, vần của nó và nhóm vần (A, B, C…) để thấy câu nào vần với câu nào. */
export function rhymeScheme(lines: LyricLine[]): LineRhyme[] {
  const letters = new Map<string, string>()
  const counts = new Map<string, number>()
  const ends = lines.map((l) => {
    const word = l.syllables.at(-1) ?? ''
    return { line: l.index, word: bareWord(word), rhyme: rhymeOf(word), bang: isBang(toneOf(word)) }
  })
  for (const e of ends) if (e.rhyme) counts.set(e.rhyme, (counts.get(e.rhyme) ?? 0) + 1)
  return ends.map((e) => {
    if (!e.rhyme || (counts.get(e.rhyme) ?? 0) < 2) return { ...e, group: null }
    if (!letters.has(e.rhyme)) letters.set(e.rhyme, String.fromCharCode(65 + letters.size))
    return { ...e, group: letters.get(e.rhyme)! }
  })
}

/** Chữ hay gặp trong lời bài hát, dùng để gợi ý chữ cùng vần. */
const WORDS = `
anh em ta mình người đời tình yêu thương nhớ mong chờ đợi tim lòng hồn mắt môi tay vai tóc má
ngày đêm trời mây gió mưa nắng hoa lá cây sông biển núi đồi rừng trăng sao mặt trời bình minh hoàng hôn chiều sớm khuya
xa gần đi về đến qua lại bên cạnh cùng nhau mãi luôn hoài thôi rồi đâu đây kia nào sao vậy thế
buồn vui khóc cười say mê đắm đau nhói xót thương hờn giận ghen tiếc nuối hối hạnh phúc êm dịu ngọt ngào
xanh đỏ vàng tím hồng trắng đen nâu bạc
năm tháng mùa xuân hạ thu đông tuổi thơ trẻ già xưa nay mai sau trước
phố đường làng quê nhà cửa sân ngõ góc phòng thềm hiên bến đò thuyền cầu ga
ước mơ khát vọng niềm tin hy vọng tương lai quá khứ kỷ niệm lời ca hát câu chuyện bài thơ
một hai ba bốn trăm nghìn vạn ngàn muôn
bay chạy đứng ngồi nằm ngủ thức tỉnh nghe nhìn thấy nói kể hỏi gọi tìm lạc trôi rơi tan vỡ phai nhạt
cháy lửa sóng gió bão giông mưa phùn sương khói mờ sáng tối lặng im vắng
ơi à nhé nha nhỉ chứ đấy
vai bước dài ngắn nhẹ nặng sâu cao thấp rộng hẹp đầy vơi
riêng chung lẻ đôi ai mình nhau lối đường lời hứa câu thề duyên phận kiếp
mộng mơ thơ ngây dại khờ ngây ngô vụng về
lấp lánh long lanh mênh mông bao la thênh thang chơi vơi bồi hồi xao xuyến nôn nao
chim cá bướm ong mèo cò
thắp sáng soi chiếu toả ngát hương thơm
vẫy gửi trao nhận giữ buông níu kéo ôm hôn
đẹp xinh hiền ngoan dịu dàng
gian khó vững bền mạnh mẽ kiên cường
quê hương đất nước non sông
cánh diều tuổi thơ bờ đê đồng lúa
phương trời góc bể chân mây cuối trời
thời gian không gian giấc mơ giấc ngủ
`

let WORD_INDEX: Map<string, string[]> | null = null

function wordIndex(): Map<string, string[]> {
  if (WORD_INDEX) return WORD_INDEX
  const idx = new Map<string, string[]>()
  for (const w of new Set(WORDS.normalize('NFC').split(/\s+/).filter(Boolean))) {
    const r = rhymeOf(w)
    if (!r) continue
    const list = idx.get(r) ?? []
    list.push(w)
    idx.set(r, list)
  }
  WORD_INDEX = idx
  return idx
}

/** Chữ cùng vần với `word` (không tính chính nó), thanh bằng trước. */
export function rhymeSuggestions(word: string, limit = 16): { word: string; bang: boolean }[] {
  const r = rhymeOf(word)
  if (!r) return []
  const self = bareWord(word)
  return (wordIndex().get(r) ?? [])
    .filter((w) => w !== self)
    .map((w) => ({ word: w, bang: isBang(toneOf(w)) }))
    .sort((a, b) => Number(b.bang) - Number(a.bang))
    .slice(0, limit)
}

// ---------- Sinh giai điệu theo lời ----------

/** Số ô nhịp cho một câu lời: câu ngắn 2 ô, câu dài 4 ô. */
function barsForLine(n: number): number {
  return n <= 8 ? 2 : 4
}

/**
 * Viết giai điệu cho lời: mỗi chữ một nốt, nhịp chia đều trong câu, chữ cuối câu ngân dài.
 * Cao độ đi theo thanh điệu: chữ sắc, ngã đi lên; huyền, nặng, hỏi đi xuống; ngang đi ngang hoặc bước nhỏ.
 * Chữ cuối câu rơi vào nốt của hợp âm để nghe "chốt". Trả về giai điệu và số ô nhịp cần.
 */
export function melodyFromLyrics(song: Song, lines: LyricLine[], seed: number, fromBar = 0): { melody: Note[]; bars: number; starts: number[] } {
  const rng = createRng(seed)
  const { lowDeg, highDeg } = melodyRange(song)
  const toMidi = (d: number) => degreeToMidi(d, song.tonic, song.mode)
  const chordAt = (bar: number) => song.chords[bar % song.chords.length]
  const isChordTone = (d: number, bar: number) => chordPcs(chordAt(bar), song.tonic, song.mode).includes(((toMidi(d) % 12) + 12) % 12)
  const nearestChordTone = (d: number, bar: number, dir = 0) => {
    const offs = dir < 0 ? [0, -1, -2, -3] : dir > 0 ? [0, 1, 2, 3] : [0, -1, 1, -2, 2, -3, 3]
    for (const off of offs) {
      const x = d + off
      if (x >= lowDeg && x <= highDeg && isChordTone(x, bar)) return x
    }
    return d
  }
  const mid = Math.round((lowDeg + highDeg) / 2)
  const melody: Note[] = []
  const starts: number[] = []
  let bar = fromBar
  let deg = nearestChordTone(mid - 1, bar)
  let prevTone: Tone = 'ngang'
  for (const line of lines) {
    const span = barsForLine(line.syllables.length) * STEPS_PER_BAR
    const n = line.syllables.length
    const start = bar * STEPS_PER_BAR
    starts.push(start)
    // Chữ cuối giữ khoảng 1/4 câu; các chữ còn lại chia đều phần trước, làm tròn về móc đơn khi được.
    const body = Math.floor(span * 0.75)
    const unit = n > 1 ? Math.max(1, Math.floor(body / (n - 1))) : 0
    const each = unit >= 2 ? unit - (unit % 2) : unit
    line.syllables.forEach((w, j) => {
      const tone = toneOf(w)
      if (j === 0) {
        // Đầu câu: về gần giữa tầm cữ, lệch theo thanh của chữ đầu.
        deg = nearestChordTone(mid + TONE_HEIGHT[tone] - 1, bar)
      } else {
        const diff = TONE_HEIGHT[tone] - TONE_HEIGHT[prevTone]
        let move = diff > 0 ? rng.int(1, 2) : diff < 0 ? -rng.int(1, 2) : rng.pick([-1, 0, 0, 1])
        if (tone === 'hoi' || tone === 'nang') move = Math.min(move, -1)
        if (tone === 'sac' && move <= 0) move = 1
        deg = Math.max(lowDeg, Math.min(highDeg, deg + move))
      }
      const last = j === n - 1
      const noteStart = start + j * each
      const noteBar = Math.floor(noteStart / STEPS_PER_BAR)
      if (last) {
        // Chốt câu bằng nốt hợp âm, tìm theo đúng hướng thanh điệu để không đi ngược thanh.
        const diff = j > 0 ? TONE_HEIGHT[tone] - TONE_HEIGHT[toneOf(line.syllables[j - 1])] : 0
        deg = nearestChordTone(deg, noteBar, diff)
      }
      // Chữ cuối ngân tới trước câu sau một phách để lấy hơi (cũng là chỗ tách câu khi gắn lời).
      const dur = last ? Math.max(each, start + span - noteStart - PHRASE_GAP) : Math.max(1, each)
      melody.push({ id: newId(), pitch: toMidi(deg), start: noteStart, dur, vel: j === 0 || last ? 96 : 88 })
      prevTone = tone
    })
    bar += span / STEPS_PER_BAR
  }
  return { melody, bars: bar, starts }
}

/** Lời bài để tải về: tên bài rồi từng câu, giữ các nhãn [Điệp khúc]. */
export function lyricsFile(title: string, text: string): string {
  return `${title.trim() || 'Bài hát'}\n\n${text.normalize('NFC').trim()}\n`
}
