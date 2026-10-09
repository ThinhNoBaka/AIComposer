import { describe, expect, it } from 'vitest'
import { copyClip, deleteNotes, duplicateNotes, moveNotes, notesInBox, pasteClip } from './edit'
import type { Note } from './song'

const n = (id: string, pitch: number, start: number, dur = 4): Note => ({ id, pitch, start, dur, vel: 90 })
const MEL = [n('a', 60, 0), n('b', 62, 4), n('c', 64, 8, 2), n('d', 65, 16)]

describe('chép và dán', () => {
  it('chép giữ vị trí tương đối và độ dài tròn phách', () => {
    const clip = copyClip(MEL, new Set(['b', 'c']))!
    expect(clip.notes.map((x) => [x.pitch, x.start, x.dur])).toEqual([
      [62, 0, 4],
      [64, 4, 2],
    ])
    expect(clip.length).toBe(8)
  })

  it('dán tại chỗ phát, thay nốt trùng cao độ, cắt ở mép', () => {
    const clip = copyClip(MEL, new Set(['a', 'b']))!
    const { melody, ids } = pasteClip(MEL, clip, 16, 22)
    expect(ids).toHaveLength(2)
    const pasted = melody.filter((x) => ids.includes(x.id))
    expect(pasted.map((x) => [x.pitch, x.start, x.dur])).toEqual([
      [60, 16, 4],
      [62, 20, 2],
    ])
    // Nốt 'd' (65) không trùng cao độ nên vẫn còn.
    expect(melody.some((x) => x.id === 'd')).toBe(true)
    const again = pasteClip(melody, clip, 16, 64)
    expect(again.melody.filter((x) => x.start === 16 && x.pitch === 60)).toHaveLength(1)
  })

  it('nhân đôi đặt ngay sau đoạn chọn', () => {
    const { melody, ids } = duplicateNotes(MEL, new Set(['a', 'b']), 64)
    expect(melody.filter((x) => ids.includes(x.id)).map((x) => x.start)).toEqual([8, 12])
  })
})

describe('dời, xoá, chọn khung', () => {
  it('dời cả nhóm và dừng ở mép', () => {
    const ids = new Set(['a', 'b'])
    const moved = moveNotes(MEL, ids, -3, 2, 64)
    expect(moved.filter((x) => ids.has(x.id)).map((x) => [x.pitch, x.start])).toEqual([
      [62, 0],
      [64, 4],
    ])
    expect(moveNotes(MEL, ids, 100, 0, 32).find((x) => x.id === 'b')!.start).toBe(28)
  })

  it('xoá nhóm', () => {
    expect(deleteNotes(MEL, new Set(['a', 'd'])).map((x) => x.id)).toEqual(['b', 'c'])
  })

  it('khung chọn kéo ngược chiều vẫn đúng', () => {
    expect(notesInBox(MEL, 10, 5, 64, 60).sort()).toEqual(['b', 'c'])
  })
})
