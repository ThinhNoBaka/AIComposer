// Thao tác chỉnh sửa trên nhiều nốt cùng lúc: chọn bằng khung, dời cả nhóm, sao chép, dán, nhân đôi, xoá.
// Hàm thuần (không đụng giao diện) để test được.

import { newId, type Note } from './song'

/** Đoạn nốt đã sao chép: vị trí tính từ nốt sớm nhất (bước 0), độ dài làm tròn lên trọn phách. */
export type Clip = { notes: Omit<Note, 'id'>[]; length: number }

export const PITCH_MIN = 36
export const PITCH_MAX = 96

const roundUpBeat = (steps: number) => Math.max(4, Math.ceil(steps / 4) * 4)

export function copyClip(melody: Note[], ids: Set<string>): Clip | null {
  const sel = melody.filter((n) => ids.has(n.id))
  if (!sel.length) return null
  const from = Math.min(...sel.map((n) => n.start))
  const to = Math.max(...sel.map((n) => n.start + n.dur))
  return {
    notes: sel.map(({ pitch, start, dur, vel }) => ({ pitch, start: start - from, dur, vel })),
    length: roundUpBeat(to - from),
  }
}

/**
 * Dán đoạn đã chép vào vị trí `at`. Nốt cũ trùng cao độ và chồng thời gian với nốt dán bị thay.
 * Nốt vượt quá `maxStep` bị bỏ, nốt chạm mép bị cắt ngắn. Trả về giai điệu mới và id các nốt vừa dán (để chọn chúng).
 */
export function pasteClip(melody: Note[], clip: Clip, at: number, maxStep: number): { melody: Note[]; ids: string[] } {
  const added: Note[] = []
  for (const n of clip.notes) {
    const start = at + n.start
    if (start >= maxStep) continue
    added.push({ ...n, id: newId(), start, dur: Math.min(n.dur, maxStep - start) })
  }
  const clash = (a: Note, b: Note) => a.pitch === b.pitch && a.start < b.start + b.dur && b.start < a.start + a.dur
  const kept = melody.filter((m) => !added.some((n) => clash(m, n)))
  return { melody: [...kept, ...added].sort((a, b) => a.start - b.start), ids: added.map((n) => n.id) }
}

/** Nhân đôi các nốt đang chọn, đặt ngay sau chúng (cách đúng độ dài đoạn chọn, tròn phách). */
export function duplicateNotes(melody: Note[], ids: Set<string>, maxStep: number): { melody: Note[]; ids: string[] } {
  const clip = copyClip(melody, ids)
  if (!clip) return { melody, ids: [] }
  const from = Math.min(...melody.filter((n) => ids.has(n.id)).map((n) => n.start))
  return pasteClip(melody, clip, from + clip.length, maxStep)
}

/** Dời cả nhóm; nhóm chạm mép (đầu bài, cuối vùng, cao/thấp nhất) thì dừng lại ở mép, giữ nguyên hình dạng. */
export function moveNotes(melody: Note[], ids: Set<string>, dStep: number, dPitch: number, maxStep: number): Note[] {
  const sel = melody.filter((n) => ids.has(n.id))
  if (!sel.length || (dStep === 0 && dPitch === 0)) return melody
  const minStart = Math.min(...sel.map((n) => n.start))
  const maxEnd = Math.max(...sel.map((n) => n.start + n.dur))
  const lo = Math.min(...sel.map((n) => n.pitch))
  const hi = Math.max(...sel.map((n) => n.pitch))
  const ds = Math.max(-minStart, Math.min(maxStep - maxEnd, dStep))
  const dp = Math.max(PITCH_MIN - lo, Math.min(PITCH_MAX - hi, dPitch))
  if (ds === 0 && dp === 0) return melody
  return melody.map((n) => (ids.has(n.id) ? { ...n, start: n.start + ds, pitch: n.pitch + dp } : n))
}

export function deleteNotes(melody: Note[], ids: Set<string>): Note[] {
  return melody.filter((n) => !ids.has(n.id))
}

/** Id các nốt chạm vào khung chọn [s0, s1) x [p0, p1] (khung có thể kéo theo chiều nào cũng được). */
export function notesInBox(melody: Note[], s0: number, s1: number, p0: number, p1: number): string[] {
  const [a, b] = s0 <= s1 ? [s0, s1] : [s1, s0]
  const [lo, hi] = p0 <= p1 ? [p0, p1] : [p1, p0]
  return melody.filter((n) => n.start < b && n.start + n.dur > a && n.pitch >= lo && n.pitch <= hi).map((n) => n.id)
}
