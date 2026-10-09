import { NO_CHORD, type Chord, type Mode } from './theory'
import type { ChordStyle, DrumStyle, Song } from './song'

export type Mood = {
  id: string
  label: string
  hint: string
  tonic: number
  mode: Mode
  bpm: number
  /** Các vòng 4 hợp âm, ghi bằng bậc 0..6. */
  progressions: number[][]
  sevenths: boolean
  chordStyle: ChordStyle
  drumStyle: DrumStyle
  drumKit: string
  swing: number
  instruments: { melody: string; chords: string; bass: string }
}

// tonic: 0 = C, 2 = D, 4 = E, 5 = F, 7 = G, 9 = A
export const MOODS: Mood[] = [
  {
    id: 'vui',
    label: 'Vui tươi',
    hint: 'Pop sáng sủa, nhịp vừa',
    tonic: 0,
    mode: 'major',
    bpm: 112,
    progressions: [[0, 4, 5, 3], [0, 5, 3, 4], [3, 4, 0, 5]],
    sevenths: false,
    chordStyle: 'pulse',
    drumStyle: 'pop',
    drumKit: 'LM-2',
    swing: 0,
    instruments: { melody: 'electric_piano_1', chords: 'acoustic_guitar_steel', bass: 'electric_bass_finger' },
  },
  {
    id: 'buon',
    label: 'Buồn, sâu lắng',
    hint: 'Ballad chậm, giọng thứ',
    tonic: 9,
    mode: 'minor',
    bpm: 72,
    progressions: [[0, 5, 2, 6], [0, 3, 6, 2], [0, 6, 5, 4]],
    sevenths: false,
    chordStyle: 'arpeggio',
    drumStyle: 'ballad',
    drumKit: 'LM-2',
    swing: 0,
    instruments: { melody: 'acoustic_grand_piano', chords: 'string_ensemble_1', bass: 'acoustic_bass' },
  },
  {
    id: 'chill',
    label: 'Chill lo-fi',
    hint: 'Thư giãn, hợp âm 7, nhịp đung đưa',
    tonic: 5,
    mode: 'major',
    bpm: 80,
    progressions: [[1, 4, 0, 5], [0, 5, 1, 4], [3, 2, 1, 0]],
    sevenths: true,
    chordStyle: 'block',
    drumStyle: 'lofi',
    drumKit: 'MFB-512',
    swing: 0.25,
    instruments: { melody: 'electric_piano_2', chords: 'electric_piano_1', bass: 'fretless_bass' },
  },
  {
    id: 'hung',
    label: 'Hào hùng',
    hint: 'Sử thi, kèn đồng và dàn dây',
    tonic: 2,
    mode: 'minor',
    bpm: 92,
    progressions: [[0, 5, 2, 6], [0, 6, 5, 6], [5, 6, 0, 0]],
    sevenths: false,
    chordStyle: 'pulse',
    drumStyle: 'epic',
    drumKit: 'Roland CR-8000',
    swing: 0,
    instruments: { melody: 'french_horn', chords: 'string_ensemble_1', bass: 'contrabass' },
  },
  {
    id: 'langman',
    label: 'Lãng mạn',
    hint: 'Ngọt ngào, guitar và violin',
    tonic: 7,
    mode: 'major',
    bpm: 84,
    progressions: [[0, 2, 3, 4], [0, 5, 1, 4], [3, 4, 2, 5]],
    sevenths: false,
    chordStyle: 'arpeggio',
    drumStyle: 'ballad',
    drumKit: 'LM-2',
    swing: 0,
    instruments: { melody: 'violin', chords: 'acoustic_guitar_nylon', bass: 'acoustic_bass' },
  },
  {
    id: 'soi',
    label: 'Sôi động',
    hint: 'Nhảy, EDM, trống dồn',
    tonic: 9,
    mode: 'minor',
    bpm: 124,
    progressions: [[0, 5, 2, 6], [5, 6, 0, 0], [0, 3, 5, 6]],
    sevenths: false,
    chordStyle: 'pulse',
    drumStyle: 'dance',
    drumKit: 'TR-808',
    swing: 0,
    instruments: { melody: 'lead_2_sawtooth', chords: 'pad_3_polysynth', bass: 'synth_bass_1' },
  },
  {
    id: 'mo',
    label: 'Mơ màng',
    hint: 'Nền pad bồng bềnh, không trống',
    tonic: 4,
    mode: 'dorian',
    bpm: 70,
    progressions: [[0, 3, 0, 3], [0, 6, 3, 0]],
    sevenths: true,
    chordStyle: 'block',
    drumStyle: 'none',
    drumKit: 'TR-808',
    swing: 0,
    instruments: { melody: 'vibraphone', chords: 'pad_2_warm', bass: 'fretless_bass' },
  },
  {
    id: 'dan',
    label: 'Dân gian',
    hint: 'Ngũ cung, sáo và koto',
    tonic: 7,
    mode: 'majorPentatonic',
    bpm: 90,
    progressions: [[0, 3, 0, 4], [0, 5, 3, 4], [5, 3, 0, 0]],
    sevenths: false,
    chordStyle: 'arpeggio',
    drumStyle: 'ballad',
    drumKit: 'Casio-RZ1',
    swing: 0,
    instruments: { melody: 'shakuhachi', chords: 'koto', bass: 'acoustic_bass' },
  },
]

/** Chưa chọn cảm xúc: ô nhịp trống, không hợp âm, không trống. */
export const NO_MOOD = 'none'

export function getMood(id: string): Mood {
  return MOODS.find((m) => m.id === id) ?? MOODS[0]
}

export function progressionToChords(prog: number[], bars: number, sevenths: boolean): Chord[] {
  return Array.from({ length: bars }, (_, i) => ({ degree: prog[i % prog.length], seventh: sevenths }))
}

export function songFromMood(mood: Mood, bars = 8): Song {
  return {
    version: 1,
    title: 'Bài hát mới',
    moodId: mood.id,
    tonic: mood.tonic,
    mode: mood.mode,
    bpm: mood.bpm,
    bars,
    chords: progressionToChords(mood.progressions[0], bars, mood.sevenths),
    melody: [],
    tracks: {
      melody: { instrument: mood.instruments.melody, volume: 0.9, muted: false },
      chords: { instrument: mood.instruments.chords, volume: 0.6, muted: false },
      bass: { instrument: mood.instruments.bass, volume: 0.75, muted: false },
      drums: { instrument: mood.drumKit, volume: 0.7, muted: mood.drumStyle === 'none' },
    },
    chordStyle: mood.chordStyle,
    drumStyle: mood.drumStyle,
    density: 1,
    swing: mood.swing,
    fx: [],
    fxVolume: 0.7,
    seed: 1,
  }
}

/** Bài trống: chưa chọn cảm xúc, không hợp âm, không trống, nhạc cụ piano. */
export function emptySong(bars = 8): Song {
  const base = songFromMood(MOODS[0], bars)
  return {
    ...base,
    moodId: NO_MOOD,
    tonic: 0,
    mode: 'major',
    bpm: 100,
    chords: Array.from({ length: bars }, () => ({ ...NO_CHORD })),
    tracks: {
      melody: { instrument: 'acoustic_grand_piano', volume: 0.9, muted: false },
      chords: { instrument: 'acoustic_grand_piano', volume: 0.6, muted: false },
      bass: { instrument: 'acoustic_bass', volume: 0.75, muted: false },
      drums: { ...base.tracks.drums, muted: true },
    },
    chordStyle: 'block',
    drumStyle: 'none',
    swing: 0,
  }
}
