// Từ bản ngân nga thành bài: đặt giai điệu (thay mới hoặc ghép nối tiếp từng đoạn), tự hoà âm,
// rồi "hoàn thiện" thành bài có dạo đầu, đoạn chính, điệp khúc và kết.

import { varyMelody } from './melody'
import { NO_MOOD, getMood, progressionToChords } from './moods'
import { MAX_BARS, STEPS_PER_BAR, newId, type Note, type Section, type Song } from './song'
import { harmonize } from './suggest'
import { NO_CHORD, isInScale, snapToScale, type Chord, type Mode } from './theory'

export { MAX_BARS }

/** Thời lượng bài (giây). */
export function songSeconds(song: Pick<Song, 'bars' | 'bpm'>): number {
  return (song.bars * 4 * 60) / song.bpm
}

export function formatDuration(sec: number): string {
  const s = Math.round(sec)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export type HummedMelody = {
  bpm: number
  tonic: number
  mode: string
  bars: number
  melody: { pitch: number; start: number; dur: number; vel: number }[]
}

export type ApplyOptions = { useKey: boolean; useBpm: boolean; autoHarmony: boolean }

const roundUp4 = (bars: number) => Math.max(4, Math.ceil(bars / 4) * 4)

/** Hợp âm mặc định trước khi tự hoà âm: vòng của cảm xúc, hoặc ô trống nếu chưa chọn cảm xúc. */
function baseChords(song: Song, bars: number, sevenths: boolean): Chord[] {
  if (song.moodId === NO_MOOD) return Array.from({ length: bars }, () => ({ ...NO_CHORD }))
  return progressionToChords(getMood(song.moodId).progressions[0], bars, sevenths)
}

export function melodyEndBar(song: Song): number {
  const end = song.melody.length ? Math.max(...song.melody.map((n) => n.start + n.dur)) : 0
  return Math.ceil(end / STEPS_PER_BAR)
}

/** Đặt các nốt ngân vào bài từ ô `fromBar`, cắt phần vượt giới hạn. */
function placeNotes(hum: HummedMelody, fromBar: number, limitBars: number, pitchOf: (p: number) => number) {
  const offset = fromBar * STEPS_PER_BAR
  const limit = limitBars * STEPS_PER_BAR
  let dropped = 0
  const notes: Note[] = []
  for (const n of hum.melody) {
    const start = n.start + offset
    if (start >= limit) {
      dropped++
      continue
    }
    notes.push({
      id: newId(),
      pitch: pitchOf(n.pitch),
      start,
      dur: Math.max(1, Math.min(n.dur, limit - start)),
      vel: Math.max(1, Math.min(127, n.vel)),
    })
  }
  return { notes, dropped }
}

/** Thay toàn bộ giai điệu bằng bản ngân (đoạn đầu tiên của bài). */
export function applyHumming(song: Song, hum: HummedMelody, opts: ApplyOptions): { song: Song; dropped: number } {
  const mood = getMood(song.moodId)
  const useKey = opts.useKey && (hum.mode === 'major' || hum.mode === 'minor')
  const tonic = useKey ? hum.tonic : song.tonic
  const mode: Mode = useKey ? (hum.mode as Mode) : song.mode
  const bpm = opts.useBpm ? Math.round(Math.min(180, Math.max(50, hum.bpm))) : song.bpm
  // Làm tròn số ô lên bội của 4 (một câu nhạc).
  const bars = Math.min(MAX_BARS, roundUp4(hum.bars))
  // Giọng giữ nguyên thì đưa nốt vào thang hiện tại để piano roll khoá thang vẫn đúng.
  const { notes, dropped } = placeNotes(hum, 0, bars, (p) => (useKey ? p : snapToScale(p, tonic, mode)))
  const sevenths = song.chords[0]?.seventh ?? mood.sevenths
  let next: Song = {
    ...song,
    tonic,
    mode,
    bpm,
    bars,
    chords: baseChords(song, bars, sevenths),
    melody: notes,
    fx: song.fx.filter((f) => f.start < bars * STEPS_PER_BAR),
    sections: undefined,
  }
  if (opts.autoHarmony && notes.length) next = { ...next, chords: harmonize(next) }
  return { song: next, dropped }
}

/**
 * Dịch bản ngân về giọng của bài: thử dịch -6..+5 nửa cung, chọn cách để nhiều nốt (tính theo trường độ)
 * rơi vào thang âm của bài nhất, hoà thì chọn dịch ít nhất. Người ngân đoạn sau thường lệch giọng so với đoạn trước.
 */
export function fitShift(hum: HummedMelody, tonic: number, mode: Mode): number {
  let best = 0
  let bestScore = -Infinity
  for (const shift of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, -6]) {
    let score = 0
    for (const n of hum.melody) if (isInScale(n.pitch + shift, tonic, mode)) score += n.dur
    if (score > bestScore + 1e-9) {
      bestScore = score
      best = shift
    }
  }
  return best
}

/** Ghép bản ngân nối tiếp sau giai điệu đang có, giữ giọng, tempo và hợp âm của phần cũ. */
export function appendHumming(song: Song, hum: HummedMelody, opts: { autoHarmony: boolean }): { song: Song; dropped: number } {
  const mood = getMood(song.moodId)
  // Đoạn mới bắt đầu ở đầu câu nhạc kế tiếp (bội của 4 ô) cho đúng phách mạnh.
  const fromBar = Math.ceil(melodyEndBar(song) / 4) * 4
  const bars = Math.min(MAX_BARS, fromBar + roundUp4(hum.bars))
  const shift = fitShift(hum, song.tonic, song.mode)
  const { notes, dropped } = placeNotes(hum, fromBar, bars, (p) => snapToScale(p + shift, song.tonic, song.mode))
  const sevenths = song.chords[0]?.seventh ?? mood.sevenths
  const fresh = baseChords(song, bars, sevenths)
  const oldChords = song.chords.slice(0, fromBar)
  let next: Song = {
    ...song,
    bars,
    chords: [...oldChords, ...fresh.slice(fromBar)],
    melody: [...song.melody.filter((n) => n.start < fromBar * STEPS_PER_BAR), ...notes],
    fx: song.fx.filter((f) => f.start < bars * STEPS_PER_BAR),
    sections: undefined,
  }
  if (opts.autoHarmony && notes.length) {
    // Chỉ hoà âm lại phần mới, phần cũ người dùng có thể đã chỉnh tay.
    const h = harmonize(next)
    next = { ...next, chords: [...oldChords, ...h.slice(fromBar)] }
  }
  return { song: next, dropped }
}

/** Còn chỗ để ghép thêm một đoạn ngân không. */
export function canAppend(song: Song): boolean {
  return !song.sections && song.melody.length > 0 && Math.ceil(melodyEndBar(song) / 4) * 4 + 4 <= MAX_BARS
}

/**
 * Hoàn thiện bài từ phần giai điệu đang có (gọi là "đoạn chính"):
 * dạo đầu (chỉ hợp âm, không trống) → đoạn chính → điệp khúc (biến tấu, đệm dày hơn, có riser dẫn vào)
 * → lặp đoạn chính/điệp khúc cho tới khi đủ `targetSeconds` → kết về chủ âm.
 */
export function arrangeSong(song: Song, seed: number, targetSeconds = 0): Song {
  const core = Math.min(song.bars, roundUp4(melodyEndBar(song)))
  const intro = core >= 8 ? 4 : 2
  const outro = 2
  const want = Math.round((targetSeconds * song.bpm) / 240)

  const parts: ('verse' | 'chorus')[] = ['verse']
  let total = intro + core + outro
  if (total + core <= MAX_BARS) {
    parts.push('chorus')
    total += core
  }
  // Thêm từng cặp đoạn chính + điệp khúc, không vượt quá mong muốn hơn một đoạn; thiếu thì lặp điệp khúc cuối.
  while (total < want && total + 2 * core <= Math.min(MAX_BARS, want + core)) {
    parts.push('verse', 'chorus')
    total += 2 * core
  }
  if (total < want && total + core <= MAX_BARS) {
    parts.push('chorus')
    total += core
  }

  const coreChords = song.chords.slice(0, core)
  const coreMelody = song.melody.filter((n) => n.start < core * STEPS_PER_BAR)
  // Dạo đầu đi theo vài hợp âm đầu, ô cuối là bậc V để dẫn vào đoạn chính.
  const introChords: Chord[] = Array.from({ length: intro }, (_, i) => ({ ...coreChords[i % coreChords.length] }))
  introChords[intro - 1] = { degree: 4, seventh: coreChords[0]?.seventh ?? false }
  const tonicChord: Chord = { degree: 0, seventh: false }

  const shift = (notes: Note[], bar: number, velAdd = 0) =>
    notes.map((n) => ({ ...n, id: newId(), start: n.start + bar * STEPS_PER_BAR, vel: Math.min(127, n.vel + velAdd) }))
  // Điệp khúc lần nào cũng giống nhau (dễ nhớ); đoạn chính từ lần 2 được biến tấu nhẹ.
  const chorusMelody = varyMelody({ ...song, melody: coreMelody }, seed)

  const sections: Section[] = [{ kind: 'intro', start: 0, bars: intro }]
  const chords: Chord[] = [...introChords]
  const melody: Note[] = []
  const fx = song.fx
    .filter((f) => f.start < core * STEPS_PER_BAR)
    .map((f) => ({ ...f, id: newId('f'), start: f.start + intro * STEPS_PER_BAR }))
  let bar = intro
  let verses = 0
  for (const kind of parts) {
    sections.push({ kind, start: bar, bars: core })
    chords.push(...coreChords.map((c) => ({ ...c })))
    if (kind === 'verse') {
      melody.push(...shift(verses === 0 ? coreMelody : varyMelody({ ...song, melody: coreMelody }, seed + 101 * verses), bar))
      verses++
    } else {
      melody.push(...shift(chorusMelody, bar, 8))
      fx.push({ id: newId('f'), fx: 'riser', start: (bar - 1) * STEPS_PER_BAR })
    }
    bar += core
  }

  // Nốt kết: chủ âm gần nốt cuối cùng nhất, ngân hết phần kết.
  const last = coreMelody.length ? coreMelody.reduce((a, b) => (b.start > a.start ? b : a)) : null
  let end = song.tonic + 12 * Math.round(((last?.pitch ?? 67) - song.tonic) / 12)
  while (end < 60) end += 12
  while (end > 79) end -= 12
  melody.push({ id: newId(), pitch: end, start: bar * STEPS_PER_BAR, dur: outro * STEPS_PER_BAR, vel: 90 })
  sections.push({ kind: 'outro', start: bar, bars: outro })
  chords.push(tonicChord, { ...tonicChord })

  return { ...song, bars: bar + outro, chords, melody, fx, sections }
}

/** Đổi độ dài bài: thêm ô thì lặp lại vòng hợp âm đang có, bớt ô thì cắt giai điệu và hiệu ứng phía sau. */
export function resizeSong(song: Song, bars: number): Song {
  const n = Math.min(MAX_BARS, Math.max(1, Math.round(bars)))
  if (n === song.bars) return song
  const limit = n * STEPS_PER_BAR
  const src = song.chords.length ? song.chords : [{ degree: 0, seventh: false }]
  return {
    ...song,
    bars: n,
    chords: Array.from({ length: n }, (_, i) => ({ ...src[i % src.length] })),
    melody: song.melody.filter((x) => x.start < limit).map((x) => ({ ...x, dur: Math.min(x.dur, limit - x.start) })),
    fx: song.fx.filter((f) => f.start < limit),
    // Đổi độ dài làm cấu trúc cũ không còn đúng.
    sections: undefined,
  }
}

/**
 * Kéo dài bài tới `bars` ô (chỉ thêm, không bớt), giữ nguyên cấu trúc đã có.
 * Hợp âm ô mới lặp lại vòng hợp âm: bài đã hoàn thiện thì lặp đoạn chính/điệp khúc cuối, chưa thì lặp từ đầu bài.
 */
export function extendSong(song: Song, bars: number): Song {
  const n = Math.min(MAX_BARS, Math.ceil(bars))
  if (n <= song.bars) return song
  const body = song.sections?.filter((x) => x.kind === 'verse' || x.kind === 'chorus').at(-1)
  const src = body ? song.chords.slice(body.start, body.start + body.bars) : song.chords
  const loop = src.length ? src : [{ degree: 0, seventh: false }]
  const extra = Array.from({ length: n - song.bars }, (_, i) => ({ ...loop[i % loop.length] }))
  return { ...song, bars: n, chords: [...song.chords, ...extra] }
}

/** Ô cuối cùng còn nốt hoặc hiệu ứng (để bỏ các ô trống thừa ở cuối bài). */
export function contentEndBar(song: Song): number {
  const fxEnd = song.fx.length ? Math.max(...song.fx.map((f) => f.start + 1)) : 0
  const secEnd = song.sections?.length ? Math.max(...song.sections.map((x) => x.start + x.bars)) : 0
  return Math.max(1, melodyEndBar(song), Math.ceil(fxEnd / STEPS_PER_BAR), secEnd)
}

/** Bài đã hoàn thiện: chèn thêm một lượt đoạn chính + điệp khúc ngay trước phần kết. */
export function addRound(song: Song, seed: number): Song | null {
  const secs = song.sections
  const outro = secs?.at(-1)
  const verse = secs?.find((x) => x.kind === 'verse')
  if (!secs || !outro || outro.kind !== 'outro' || !verse) return null
  const chorus = secs.find((x) => x.kind === 'chorus')
  const parts = chorus ? [verse, chorus] : [verse]
  const add = parts.reduce((s, x) => s + x.bars, 0)
  if (song.bars + add > MAX_BARS) return null
  const at = outro.start
  const shiftBy = add * STEPS_PER_BAR
  const inRange = (start: number, x: Section) => start >= x.start * STEPS_PER_BAR && start < (x.start + x.bars) * STEPS_PER_BAR
  const melody: Note[] = song.melody.map((n) => (n.start >= at * STEPS_PER_BAR ? { ...n, start: n.start + shiftBy } : n))
  const fx = song.fx.map((f) => (f.start >= at * STEPS_PER_BAR ? { ...f, start: f.start + shiftBy } : f))
  const chords: Chord[] = song.chords.slice(0, at)
  const sections: Section[] = secs.slice(0, -1)
  let bar = at
  for (const x of parts) {
    const delta = (bar - x.start) * STEPS_PER_BAR
    const src = song.melody.filter((n) => inRange(n.start, x))
    // Đoạn chính lượt mới được biến tấu nhẹ; điệp khúc giữ nguyên cho dễ nhớ.
    const notes = (x.kind === 'verse' ? varyMelody({ ...song, melody: src }, seed) : src).map((n) => ({ ...n, start: n.start + delta }))
    melody.push(...notes.map((n) => ({ ...n, id: newId() })))
    chords.push(...song.chords.slice(x.start, x.start + x.bars).map((c) => ({ ...c })))
    sections.push({ kind: x.kind, start: bar, bars: x.bars })
    if (x.kind === 'chorus') fx.push({ id: newId('f'), fx: 'riser', start: (bar - 1) * STEPS_PER_BAR })
    bar += x.bars
  }
  chords.push(...song.chords.slice(at).map((c) => ({ ...c })))
  sections.push({ ...outro, start: bar })
  return { ...song, bars: song.bars + add, chords, melody, fx, sections }
}
