import { describe, expect, it } from 'vitest'
import { keepLockedNotes, lockedCount, noteIdsInSection, setNotesLocked } from './locks'
import type { Note } from './song'

const n = (id: string, start: number, dur = 4, pitch = 60, locked?: boolean): Note => ({ id, pitch, start, dur, vel: 90, ...(locked ? { locked } : {}) })

describe('khoá từng nốt', () => {
  it('giữ nốt khoá khi giai điệu bị viết lại và bỏ nốt mới đè lên nó', () => {
    const prev = [n('a', 0), n('b', 4, 4, 64, true), n('c', 8)]
    const regenerated = [n('x', 0), n('y', 2, 4, 67), n('z', 6, 4, 62), n('w', 12)]
    const out = keepLockedNotes(prev, regenerated)
    expect(out.map((x) => x.id)).toEqual(['x', 'b', 'w'])
    expect(out.find((x) => x.id === 'b')).toEqual(prev[1])
  })

  it('kéo hoặc xoá nốt khoá thì nốt quay về chỗ cũ', () => {
    const prev = [n('a', 0), n('b', 4, 4, 64, true)]
    expect(keepLockedNotes(prev, [n('a', 0), { ...prev[1], start: 12, pitch: 70 }]).find((x) => x.id === 'b')).toEqual(prev[1])
    expect(keepLockedNotes(prev, [n('a', 0)]).map((x) => x.id)).toEqual(['a', 'b'])
  })

  it('bỏ khoá có chủ ý thì được sửa bình thường', () => {
    const prev = [n('b', 4, 4, 64, true)]
    const unlocked = setNotesLocked(prev, new Set(['b']), false)
    expect(unlocked[0].locked).toBeUndefined()
    expect(keepLockedNotes(prev, unlocked)).toBe(unlocked)
  })

  it('không đổi gì thì trả lại đúng mảng cũ', () => {
    const prev = [n('a', 0), n('b', 4, 4, 64, true)]
    const next = [...prev]
    expect(keepLockedNotes(prev, next)).toBe(next)
    expect(keepLockedNotes([n('a', 0)], next)).toBe(next)
  })

  it('khoá theo đoạn lấy đúng các nốt bắt đầu trong đoạn', () => {
    const melody = [n('a', 0), n('b', 16), n('c', 31), n('d', 32)]
    const ids = noteIdsInSection(melody, { kind: 'verse', start: 1, bars: 1 }, 16)
    expect([...ids]).toEqual(['b', 'c'])
    expect(lockedCount(setNotesLocked(melody, ids, true))).toBe(2)
  })
})
