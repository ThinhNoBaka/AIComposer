import { describe, expect, it } from 'vitest'
import { generateMelody } from './melody'
import { songToMidi } from './midi'
import { detectKey, midiToSong } from './midiImport'
import { emptySong, getMood, songFromMood } from './moods'
import { MOODS } from './moods'

describe('mở file MIDI', () => {
  it('dò giọng La thứ từ biểu đồ nốt', () => {
    const hist = new Array(12).fill(0)
    for (const pc of [9, 11, 0, 2, 4, 5, 7, 9, 0, 4, 9]) hist[pc] += 1
    expect(detectKey(hist)).toEqual({ tonic: 9, mode: 'minor' })
  })

  it('mở lại được file do app xuất: giai điệu, tempo, giọng, hợp âm, lời', () => {
    const mood = getMood(MOODS[0].id)
    const base = songFromMood(mood, 8)
    const song = { ...base, title: 'Thử', melody: generateMelody(base, { seed: 7 }), lyrics: 'một hai ba bốn' }
    const res = midiToSong(songToMidi(song), emptySong())
    const got = res.song
    expect(res.melodyTrack).toBe('Giai điệu')
    expect(got.title).toBe('Thử')
    expect(got.bpm).toBe(song.bpm)
    expect([got.tonic, got.mode]).toEqual([song.tonic, song.mode === 'minor' ? 'minor' : 'major'])
    expect(got.melody.map((n) => [n.pitch, n.start, n.dur])).toEqual(song.melody.map((n) => [n.pitch, n.start, n.dur]))
    expect(got.chords.map((c) => c.degree)).toEqual(song.chords.map((c) => c.degree))
    expect(res.hasLyrics).toBe(true)
    expect(got.lyrics?.replace(/\n/g, ' ')).toBe('một hai ba bốn')
  })
})
