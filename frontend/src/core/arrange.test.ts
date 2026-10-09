import { describe, expect, it } from 'vitest'
import { Midi } from '@tonejs/midi'
import { STRUM_PATTERNS, chordTrackNotes, drumHits, strumBar, voiceChords } from './accompany'
import { SUBSTITUTES, varyArrangement } from './arrange'
import { applySwing, buildEvents, vocalEvent } from './events'
import { arrangeSong } from './humming'
import { generateMelody } from './melody'
import { songToMidi } from './midi'
import { getMood, songFromMood } from './moods'
import { gmProgram, instrumentLabel, trackProgram } from './instruments'
import {
  CUSTOM_SYNTH,
  DEFAULT_REVERB,
  DEFAULT_SYNTH,
  STEPS_PER_BAR,
  chordStyleAt,
  drumStyleAt,
  stepSeconds,
  trackEq,
  trackPan,
  trackReverb,
  validateSong,
  vocalOffsetSec,
  type Song,
  type VocalTrack,
} from './song'
import { STEM_LABEL, soloSong, stemIds } from './stems'
import { NO_CHORD, chordFunction, isNoChord } from './theory'
import { estimateLatencyMs, f0Path, notesToSeconds, pitchRange, takeOffsetMs, vocalStartPlan } from './vocal'
import { crc32, unzip, zipStore } from './zip'

function withMelody(moodId: string, seed = 7): Song {
  const s = songFromMood(getMood(moodId))
  return { ...s, melody: generateMelody(s, { seed }) }
}

const VOCAL: VocalTrack = { takeId: 't1', version: 'original', offsetMs: 1500, volume: 0.9, muted: false }

describe('quạt chả', () => {
  it('đúng nhịp D-D-U-U-D-U: quạt xuống trầm lên cao, quạt lên cao xuống trầm và nhẹ hơn', () => {
    const v = [55, 60, 64]
    const notes = strumBar(v, 0, 1, 120)
    const gap = 0.02 / stepSeconds(120)
    // Gom theo nhát quạt (ô móc đơn).
    const strokes = new Map<number, typeof notes>()
    for (const n of notes) {
      const slot = Math.floor(n.start / 2 + 1e-6)
      strokes.set(slot, [...(strokes.get(slot) ?? []), n])
    }
    expect([...strokes.keys()].sort((a, b) => a - b)).toEqual([0, 2, 3, 5, 6, 7])
    const pattern = STRUM_PATTERNS[1]
    for (const [slot, ns] of strokes) {
      const order = [...ns].sort((a, b) => a.start - b.start).map((n) => n.pitch)
      if (pattern[slot] === 'D') {
        expect(order).toEqual([43, 55, 60, 64]) // thêm nốt gốc thấp một quãng tám
        expect(ns[0].start).toBe(slot * 2)
        expect(ns[1].start - ns[0].start).toBeCloseTo(gap, 6)
      } else {
        expect(order).toEqual([64, 60, 55])
        expect(Math.max(...ns.map((n) => n.vel))).toBeLessThan(Math.min(...strokes.get(0)!.map((n) => n.vel)))
      }
      for (const n of ns) expect(n.dur).toBeGreaterThan(0)
    }
  })

  it('độ dày đổi nhịp quạt; lệch dây tính theo ms nên không phụ thuộc tempo', () => {
    expect(strumBar([60, 64, 67], 0, 0, 100).filter((n) => n.pitch === 67)).toHaveLength(2)
    expect(strumBar([60, 64, 67], 0, 2, 100).filter((n) => n.pitch === 67)).toHaveLength(8)
    const slow = strumBar([60, 64, 67], 0, 1, 60)
    const fast = strumBar([60, 64, 67], 0, 1, 180)
    expect((slow[1].start - slow[0].start) * stepSeconds(60)).toBeCloseTo((fast[1].start - fast[0].start) * stepSeconds(180), 6)
  })

  it('ô trống không có nốt, nốt nằm trong bài, MIDI vẫn xuất được', () => {
    const base = withMelody('vui')
    const s: Song = { ...base, chordStyle: 'strum', chords: base.chords.map((c, i) => (i === 2 ? { ...NO_CHORD } : c)) }
    const notes = chordTrackNotes(s)
    expect(notes.length).toBeGreaterThan(0)
    for (const n of notes) {
      expect(Math.floor(n.start / STEPS_PER_BAR)).not.toBe(2)
      expect(n.start).toBeLessThan(s.bars * STEPS_PER_BAR)
    }
    expect(voiceChords(s)[2]).toEqual([])
    const back = new Midi(songToMidi(s))
    expect(back.tracks[1].notes.length).toBe(notes.length)
  })

  it('swing đẩy cả các nốt lệch của một nhát quạt cùng nhau', () => {
    expect(applySwing(2.16, 0.25)).toBeCloseTo(2.66, 6)
    expect(applySwing(0.16, 0.25)).toBeCloseTo(0.16, 6)
  })
})

describe('biến tấu bản phối', () => {
  const full = () => arrangeSong(withMelody('vui'), 3)

  it('điệp khúc dày hơn đoạn chính, mỗi đoạn có cách đệm, cùng seed cùng kết quả', () => {
    const s = full()
    const v = varyArrangement(s, 42)
    expect(validateSong(JSON.parse(JSON.stringify(v)))).toBeNull()
    expect(varyArrangement(s, 42)).toEqual(v)
    for (const sec of s.sections!) expect(v.sectionStyles?.[sec.start]).toBeDefined()
    const verse = s.sections!.find((x) => x.kind === 'verse')!
    const chorus = s.sections!.find((x) => x.kind === 'chorus')!
    expect(['block', 'arpeggio']).toContain(chordStyleAt(v, verse.start))
    expect(['strum', 'pulse']).toContain(chordStyleAt(v, chorus.start))
    const perBar = (bar: number) => chordTrackNotes(v).filter((n) => Math.floor(n.start / STEPS_PER_BAR) === bar).length
    expect(perBar(chorus.start)).toBeGreaterThan(perBar(verse.start))
    // Trống theo từng đoạn.
    const drums = drumHits(v)
    expect(drums.some((h) => Math.floor(h.start / STEPS_PER_BAR) === chorus.start)).toBe(true)
    expect(drumStyleAt(v, chorus.start)).toBe(v.sectionStyles![chorus.start].drumStyle)
  })

  it('vòng hợp âm điệp khúc đổi sang hợp âm cùng chức năng, giữ hợp âm đầu và cuối, đoạn khác giữ nguyên', () => {
    const s = full()
    const choruses = s.sections!.filter((x) => x.kind === 'chorus')
    let changed = false
    for (const seed of [1, 2, 3, 4, 5]) {
      const v = varyArrangement(s, seed)
      for (let bar = 0; bar < s.bars; bar++) {
        const inChorus = choruses.find((x) => bar >= x.start && bar < x.start + x.bars)
        const a = s.chords[bar]
        const b = v.chords[bar]
        if (!inChorus || bar === inChorus.start || bar === inChorus.start + inChorus.bars - 1) {
          expect(b).toEqual(a)
          continue
        }
        if (a.degree !== b.degree) {
          changed = true
          expect(SUBSTITUTES[a.degree]).toContain(b.degree)
          expect(chordFunction(b.degree) === chordFunction(a.degree) || SUBSTITUTES[a.degree].includes(b.degree)).toBe(true)
        }
      }
      // Các điệp khúc giống nhau.
      if (choruses.length > 1) {
        const c0 = v.chords.slice(choruses[0].start, choruses[0].start + choruses[0].bars)
        const c1 = v.chords.slice(choruses[1].start, choruses[1].start + choruses[1].bars)
        expect(c1).toEqual(c0)
      }
    }
    expect(changed).toBe(true)
  })

  it('khoá hợp âm thì chỉ đổi cách đệm; ô trống giữ trống', () => {
    const s = full()
    const locked = varyArrangement({ ...s, locks: { chords: true } }, 9)
    expect(locked.chords).toEqual(s.chords)
    const chorus = s.sections!.find((x) => x.kind === 'chorus')!
    const holes = { ...s, chords: s.chords.map((c, i) => (i === chorus.start + 1 ? { ...NO_CHORD } : c)) }
    expect(isNoChord(varyArrangement(holes, 9).chords[chorus.start + 1])).toBe(true)
  })

  it('bài chưa chia đoạn: đổi cách đệm cả bài, không đổi hợp âm', () => {
    const s = withMelody('buon')
    const v = varyArrangement(s, 5)
    expect(v.sectionStyles).toBeUndefined()
    expect(v.chords).toEqual(s.chords)
    expect(v.chordStyle).not.toBe(s.chordStyle)
  })

  it('validateSong từ chối kiểu đệm lạ', () => {
    const s = full()
    expect(validateSong({ ...s, chordStyle: 'xyz' })).not.toBeNull()
    expect(validateSong({ ...s, sectionStyles: { 0: { chordStyle: 'strum', drumStyle: 'nope' } } })).not.toBeNull()
    expect(validateSong({ ...s, chordStyle: 'strum' })).toBeNull()
  })
})

describe('trộn từng track và synth tự chỉnh', () => {
  it('bài cũ không có pan/EQ/vang: mặc định giữ nguyên âm thanh cũ', () => {
    const s = withMelody('vui')
    expect(trackPan(s.tracks.melody)).toBe(0)
    expect(trackEq(s.tracks.bass)).toEqual({ low: 0, mid: 0, high: 0 })
    for (const id of ['melody', 'chords', 'bass', 'drums'] as const) expect(trackReverb(s.tracks[id], id)).toBe(DEFAULT_REVERB[id])
    expect(trackReverb({ ...s.tracks.melody, reverb: 0 }, 'melody')).toBe(0)
  })

  it('validateSong nhận thông số hợp lệ, từ chối giá trị ngoài khoảng', () => {
    const s = withMelody('vui')
    const t = (patch: object) => ({ ...s, tracks: { ...s.tracks, melody: { ...s.tracks.melody, ...patch } } })
    expect(validateSong(t({ pan: -0.5, eq: { low: 3, mid: -2, high: 12 }, reverb: 0.3 }))).toBeNull()
    expect(validateSong(t({ pan: 2 }))).not.toBeNull()
    expect(validateSong(t({ eq: { low: 20, mid: 0, high: 0 } }))).not.toBeNull()
    expect(validateSong(t({ reverb: -1 }))).not.toBeNull()
    expect(validateSong(t({ instrument: CUSTOM_SYNTH, synth: DEFAULT_SYNTH }))).toBeNull()
    expect(validateSong(t({ instrument: CUSTOM_SYNTH, synth: { ...DEFAULT_SYNTH, wave: 'noise' } }))).not.toBeNull()
  })

  it('synth tự chỉnh: tên tiếng Việt, MIDI dùng program synth gần nhất', () => {
    expect(instrumentLabel(CUSTOM_SYNTH)).toBe('Synth tự chỉnh')
    expect(trackProgram({ instrument: CUSTOM_SYNTH, synth: { ...DEFAULT_SYNTH, wave: 'square' } }, 'melody')).toBe(gmProgram('lead_1_square'))
    expect(trackProgram({ instrument: CUSTOM_SYNTH, synth: { ...DEFAULT_SYNTH, attack: 0.5, wave: 'sine' } }, 'chords')).toBe(gmProgram('pad_2_warm'))
    expect(trackProgram({ instrument: CUSTOM_SYNTH }, 'bass')).toBe(gmProgram('synth_bass_2'))
    expect(trackProgram({ instrument: 'violin' }, 'melody')).toBe(gmProgram('violin'))
    const s = withMelody('vui')
    const midi = new Midi(songToMidi({ ...s, tracks: { ...s.tracks, melody: { ...s.tracks.melody, instrument: CUSTOM_SYNTH, synth: DEFAULT_SYNTH, pan: -1 } } }))
    expect(midi.tracks[0].instrument.number).toBe(gmProgram('lead_2_sawtooth'))
    expect(midi.tracks[0].controlChanges[10]?.[0].value).toBe(0)
  })
})

describe('stems', () => {
  it('mỗi stem chỉ còn đúng một track kêu', () => {
    const s = { ...withMelody('vui'), fx: [{ id: 'f1', fx: 'riser', start: 4 }], vocal: VOCAL }
    const ids = stemIds(s)
    expect(ids).toEqual(['melody', 'chords', 'bass', 'drums', 'fx', 'vocal'])
    for (const id of ids) {
      const tracks = new Set(buildEvents(soloSong(s, id)).map((e) => e.track))
      expect([...tracks]).toEqual([id])
      expect(STEM_LABEL[id]).toMatch(/^[a-z-]+$/)
    }
  })

  it('track đang tắt tiếng không có stem', () => {
    const s = withMelody('vui')
    expect(stemIds({ ...s, tracks: { ...s.tracks, bass: { ...s.tracks.bass, muted: true } } })).not.toContain('bass')
  })
})

describe('zip', () => {
  it('đọc lại gói STORE do app xuất, lọc được theo tên', async () => {
    const enc = new TextEncoder()
    const files = [
      { name: 'Bài thử.aicomposer.json', data: enc.encode('{"version":1}') },
      { name: 'stems/', data: new Uint8Array() },
      { name: 'stems/a.wav', data: new Uint8Array([9, 8, 7]) },
    ]
    const all = await unzip(zipStore(files))
    expect(all.map((f) => f.name)).toEqual(['Bài thử.aicomposer.json', 'stems/a.wav'])
    expect([...all[1].data]).toEqual([9, 8, 7])
    const only = await unzip(zipStore(files), (n) => n.endsWith('.aicomposer.json'))
    expect(new TextDecoder().decode(only[0].data)).toBe('{"version":1}')
  })

  it('đọc được file nén DEFLATE (gói nén lại bằng phần mềm khác)', async () => {
    const text = 'giai điệu '.repeat(200)
    const packed = new Uint8Array(
      await new Response(new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer(),
    )
    const zip = zipStore([{ name: 'bai.aicomposer.json', data: packed }])
    const dv = new DataView(zip.buffer)
    const eocd = zip.length - 22
    const cd = dv.getUint32(eocd + 16, true)
    dv.setUint16(8, 8, true) // header của file: kiểu nén DEFLATE
    dv.setUint16(cd + 10, 8, true) // mục lục: kiểu nén DEFLATE
    const [f] = await unzip(zip)
    expect(new TextDecoder().decode(f.data)).toBe(text)
  })

  it('file không phải zip thì báo lỗi rõ ràng', async () => {
    await expect(unzip(new TextEncoder().encode('không phải zip'))).rejects.toThrow('.zip')
  })

  it('CRC32 chuẩn', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
    expect(crc32(new Uint8Array())).toBe(0)
  })

  it('cấu trúc STORE: header từng file, thư mục trung tâm, bản ghi kết thúc', () => {
    const enc = new TextEncoder()
    const files = [
      { name: 'bài hát.txt', data: enc.encode('xin chào') },
      { name: 'stems/a.wav', data: new Uint8Array([1, 2, 3, 4, 5]) },
    ]
    const zip = zipStore(files, new Date(2026, 9, 9, 8, 30, 10))
    const dv = new DataView(zip.buffer)
    const eocd = zip.length - 22
    expect(dv.getUint32(eocd, true)).toBe(0x06054b50)
    expect(dv.getUint16(eocd + 10, true)).toBe(2)
    const cdSize = dv.getUint32(eocd + 12, true)
    let cd = dv.getUint32(eocd + 16, true)
    expect(cd + cdSize).toBe(eocd)
    for (const f of files) {
      expect(dv.getUint32(cd, true)).toBe(0x02014b50)
      const nameLen = dv.getUint16(cd + 28, true)
      const name = new TextDecoder().decode(zip.slice(cd + 46, cd + 46 + nameLen))
      expect(name).toBe(f.name)
      expect(dv.getUint16(cd + 8, true) & 0x0800).toBe(0x0800)
      const local = dv.getUint32(cd + 42, true)
      expect(dv.getUint32(local, true)).toBe(0x04034b50)
      expect(dv.getUint32(local + 14, true)).toBe(crc32(f.data))
      const start = local + 30 + dv.getUint16(local + 26, true)
      expect([...zip.slice(start, start + f.data.length)]).toEqual([...f.data])
      cd += 46 + nameLen
    }
  })
})

describe('giọng hát', () => {
  it('mốc bản thu trong bài = vị trí lúc bắt đầu thu trừ độ trễ', () => {
    // Nhạc nền bắt đầu ô 3 (giây 4.0) lúc t = 12; bắt đầu thu lúc t = 10 (trong lúc đếm nhịp); trễ 30 ms.
    expect(takeOffsetMs({ playFromSec: 4, playAt: 12, recStartAt: 10, latencyMs: 30 })).toBe(1970)
    expect(takeOffsetMs({ playFromSec: 0, playAt: 12, recStartAt: 10, latencyMs: 30, nudgeMs: 20 })).toBe(-2050)
    expect(estimateLatencyMs({ outputLatency: 0.02, baseLatency: 0.005 }, 0.01)).toBeCloseTo(35, 6)
    expect(estimateLatencyMs({})).toBe(0)
  })

  it('bù trễ chỉnh tay kéo giọng sớm lên', () => {
    expect(vocalOffsetSec({ ...VOCAL, nudgeMs: 100 })).toBeCloseTo(1.4, 6)
  })

  it('nốt giai điệu đổi sang giây theo thời gian bài', () => {
    const notes = notesToSeconds(
      [
        { id: 'b', pitch: 64, start: 8, dur: 4, vel: 90 },
        { id: 'a', pitch: 60, start: 0, dur: 2, vel: 90 },
      ],
      120,
    )
    expect(notes).toEqual([
      { pitch: 60, start_s: 0, end_s: 0.25 },
      { pitch: 64, start_s: 1, end_s: 1.5 },
    ])
    expect(notesToSeconds([{ id: 'a', pitch: 60, start: 4, dur: 4, vel: 90 }], 120, 0.1)[0]).toEqual({ pitch: 60, start_s: 0.6, end_s: 1.1 })
  })

  it('đường cao độ SVG ngắt ở chỗ không có giọng', () => {
    const d = f0Path([null, 60, 61, null, 62], 0.01, (t) => t * 1000, (p) => 100 - p)
    expect(d).toBe('M10 40 L20 39 M40 38')
    expect(f0Path([null, null], 0.01, (t) => t, (p) => p)).toBe('')
    expect(pitchRange([[60.4, null, 62.7]], [58])).toEqual([56, 65])
    expect(pitchRange([[null]])).toEqual([55, 79])
  })

  it('phát từ giữa bài: chờ tới mốc bản thu, hoặc phát tiếp từ đúng chỗ', () => {
    expect(vocalStartPlan(1, 3, 10)).toEqual({ delay: 2, bufOffset: 0 })
    expect(vocalStartPlan(5, 3, 10)).toEqual({ delay: 0, bufOffset: 2 })
    expect(vocalStartPlan(14, 3, 10)).toBeNull()
    expect(vocalStartPlan(0, -0.5, 10)).toEqual({ delay: 0, bufOffset: 0.5 })
  })

  it('sự kiện giọng: mốc âm dời về 0 và bỏ qua đoạn đầu; tắt tiếng thì không phát; validate', () => {
    const s = withMelody('vui')
    expect(vocalEvent(s)).toBeNull()
    const ev = vocalEvent({ ...s, vocal: VOCAL })!
    expect(ev.start).toBeCloseTo(1.5 / stepSeconds(s.bpm), 6)
    expect(ev.skip).toBe(0)
    const neg = vocalEvent({ ...s, vocal: { ...VOCAL, offsetMs: -200 } })!
    expect(neg.start).toBe(0)
    expect(neg.skip).toBeCloseTo(0.2, 6)
    expect(vocalEvent({ ...s, vocal: { ...VOCAL, muted: true } })).toBeNull()
    expect(buildEvents({ ...s, vocal: VOCAL }).filter((e) => e.kind === 'vocal')).toHaveLength(1)
    expect(validateSong(JSON.parse(JSON.stringify({ ...s, vocal: { ...VOCAL, pan: 0.2, eq: { low: 0, mid: 2, high: -3 }, reverb: 0.4, nudgeMs: 40 } })))).toBeNull()
    expect(validateSong({ ...s, vocal: { ...VOCAL, version: 'x' } })).not.toBeNull()
    expect(validateSong({ ...s, vocal: { ...VOCAL, takeId: '' } })).not.toBeNull()
  })
})
