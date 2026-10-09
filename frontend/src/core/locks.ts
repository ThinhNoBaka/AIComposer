// Khoá từng nốt: nốt có `locked` giữ nguyên chỗ, cao độ, độ dài dù máy viết lại giai điệu hay người dùng kéo/xoá nhầm.
// Mọi thay đổi bài đi qua store gọi keepLockedNotes(bài cũ, bài mới) nên không chỗ nào phải tự nhớ kiểm tra khoá.

import type { Note, Section } from './song'

const overlaps = (a: Note, b: Note) => a.start < b.start + b.dur && b.start < a.start + a.dur

/**
 * Đưa các nốt đang khoá của `prev` trở lại `next` đúng như cũ, và bỏ những nốt mới đè lên chúng.
 * Nốt bị bỏ khoá có chủ ý (cùng id, `locked` không còn) thì để yên.
 */
export function keepLockedNotes(prev: Note[], next: Note[]): Note[] {
  const locked = prev.filter((n) => n.locked)
  if (!locked.length) return next
  const nextById = new Map(next.map((n) => [n.id, n]))
  const keep = locked.filter((n) => {
    const now = nextById.get(n.id)
    return !now || now.locked // đã bị bỏ khoá thì không giữ nữa
  })
  if (!keep.length) return next
  const keepIds = new Set(keep.map((n) => n.id))
  const rest = next.filter((n) => !keepIds.has(n.id) && !keep.some((k) => overlaps(k, n)))
  // Không có gì bị đổi: trả nguyên mảng cũ để không tạo thêm bước lịch sử.
  if (rest.length + keep.length === next.length && keep.every((k) => nextById.get(k.id) === k)) return next
  return [...rest, ...keep].sort((a, b) => a.start - b.start || a.pitch - b.pitch)
}

/** Khoá hoặc bỏ khoá các nốt có id trong `ids`. */
export function setNotesLocked(melody: Note[], ids: Set<string>, on: boolean): Note[] {
  return melody.map((n) => {
    if (!ids.has(n.id) || !!n.locked === on) return n
    if (on) return { ...n, locked: true }
    const { locked: _drop, ...rest } = n
    return rest
  })
}

/** Id các nốt bắt đầu trong một đoạn của bài (dùng cho "Khoá đoạn này"). */
export function noteIdsInSection(melody: Note[], section: Section, stepsPerBar: number): Set<string> {
  const a = section.start * stepsPerBar
  const b = (section.start + section.bars) * stepsPerBar
  return new Set(melody.filter((n) => n.start >= a && n.start < b).map((n) => n.id))
}

export const lockedCount = (melody: Note[]) => melody.reduce((k, n) => k + (n.locked ? 1 : 0), 0)
