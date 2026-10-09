import { describe as group, expect, it } from 'vitest'
import { describe, fold, parseCommand } from './commands'

const kinds = (text: string) => parseCommand(text).commands

group('lệnh tiếng Việt', () => {
  it('bỏ dấu để gõ không dấu cũng hiểu', () => {
    expect(fold('Đổi sang Buồn')).toBe('doi sang buon')
  })

  it('các câu trong kế hoạch', () => {
    expect(kinds('nhanh hơn')).toEqual([{ kind: 'tempo', delta: 10 }])
    expect(kinds('đổi sang buồn')).toEqual([{ kind: 'mood', moodId: 'buon' }])
    expect(kinds('thêm điệp khúc')).toEqual([{ kind: 'addRound' }])
    expect(kinds('giọng La thứ')).toEqual([{ kind: 'key', tonic: 9, mode: 'minor' }])
    expect(kinds('bỏ trống')).toEqual([{ kind: 'mood', moodId: 'none' }])
    expect(kinds('tempo 90')).toEqual([{ kind: 'tempo', bpm: 90 }])
  })

  it('gõ không dấu và nhiều lệnh một câu', () => {
    const r = parseCommand('cham hon mot chut, giong Re truong va dung sao truc')
    expect(r.commands).toEqual([
      { kind: 'tempo', delta: -5 },
      { kind: 'key', tonic: 2, mode: 'major' },
      { kind: 'instrument', track: 'melody', instrument: 'pan_flute', label: 'sáo trúc' },
    ])
    expect(r.unknown).toEqual([])
  })

  it('giọng viết bằng chữ cái và dấu thăng', () => {
    expect(kinds('chuyển sang giọng F# minor')).toEqual([{ kind: 'key', tonic: 6, mode: 'minor' }])
    expect(kinds('giọng Am')).toEqual([{ kind: 'key', tonic: 9, mode: 'minor' }])
  })

  it('dịch giọng, nhạc cụ hợp âm, trống, câu không hiểu', () => {
    expect(kinds('nâng lên nửa cung')).toEqual([{ kind: 'transpose', semitones: 1 }])
    expect(kinds('hạ 1 cung')).toEqual([{ kind: 'transpose', semitones: -2 }])
    expect(kinds('đổi hợp âm sang guitar')).toEqual([{ kind: 'instrument', track: 'chords', instrument: 'acoustic_guitar_nylon', label: 'guitar' }])
    expect(kinds('tắt trống')).toEqual([{ kind: 'drums', on: false }])
    expect(kinds('biến tấu bản phối')).toEqual([{ kind: 'varyArrangement' }])
    expect(parseCommand('nấu cơm đi').unknown).toEqual(['nau com di'])
  })

  it('mô tả lại lệnh', () => {
    expect(describe({ kind: 'key', tonic: 9, mode: 'minor' })).toBe('giọng La thứ (Am)')
    expect(describe({ kind: 'tempo', delta: -10 })).toBe('chậm hơn 10 BPM')
  })
})
