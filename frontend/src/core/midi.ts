import { Midi } from '@tonejs/midi'
import { GM_DRUM_NOTE } from './accompany'
import { buildEvents } from './events'
import { trackProgram } from './instruments'
import { alignLyrics, parseLyrics } from './lyrics'
import { trackPan, type Song } from './song'

/** midi-file ghi mỗi ký tự thành một byte: đổi chữ có dấu sang chuỗi byte UTF-8 trước. */
function utf8Bytes(text: string): string {
  return String.fromCharCode(...new TextEncoder().encode(text))
}

/** Xuất bài ra file MIDI chuẩn: 3 track nhạc cụ + track trống kênh 10, kèm lời (sự kiện lyric) nếu có. Hiệu ứng FX không có trong MIDI. */
export function songToMidi(song: Song): Uint8Array {
  const midi = new Midi()
  midi.header.setTempo(song.bpm)
  midi.header.name = utf8Bytes(song.title)
  const ticksPerStep = midi.header.ppq / 4

  const tracks = {
    melody: midi.addTrack(),
    chords: midi.addTrack(),
    bass: midi.addTrack(),
    drums: midi.addTrack(),
  }
  const names = { melody: 'Giai điệu', chords: 'Hợp âm', bass: 'Bass', drums: 'Trống' }
  ;(['melody', 'chords', 'bass'] as const).forEach((id, ch) => {
    tracks[id].name = utf8Bytes(names[id])
    tracks[id].channel = ch
    tracks[id].instrument.number = trackProgram(song.tracks[id], id)
  })
  tracks.drums.name = utf8Bytes(names.drums)
  tracks.drums.channel = 9
  // Pan của từng track (CC10, 0 = trái, 1 = phải).
  for (const id of ['melody', 'chords', 'bass', 'drums'] as const) {
    const pan = trackPan(song.tracks[id])
    if (pan !== 0) tracks[id].addCC({ number: 10, value: (pan + 1) / 2, ticks: 0 })
  }

  // MIDI không có swing tự động: làm tròn vị trí ra tick, giữ cảm giác đung đưa.
  for (const e of buildEvents(song)) {
    if (e.kind === 'note') {
      tracks[e.track].addNote({
        midi: e.pitch,
        ticks: Math.round(e.start * ticksPerStep),
        durationTicks: Math.max(1, Math.round(e.dur * ticksPerStep)),
        velocity: (e.vel / 127) * song.tracks[e.track].volume,
      })
    } else if (e.kind === 'drum') {
      tracks.drums.addNote({
        midi: GM_DRUM_NOTE[e.sound],
        ticks: Math.round(e.start * ticksPerStep),
        durationTicks: ticksPerStep,
        velocity: (e.vel / 127) * song.tracks.drums.volume,
      })
    }
  }
  if (song.lyrics?.trim()) {
    // Khoá căn lời: dùng đúng chữ đã gắn vào từng nốt, không căn lại.
    const map = song.locks?.align && song.lyricMap ? new Map(Object.entries(song.lyricMap)) : alignLyrics(parseLyrics(song.lyrics), song.melody).syllableOf
    for (const n of song.melody) {
      const syl = map.get(n.id)
      if (syl && syl !== '–') midi.header.meta.push({ type: 'lyrics', text: utf8Bytes(syl), ticks: Math.round(n.start * ticksPerStep) })
    }
    midi.header.meta.sort((a, b) => a.ticks - b.ticks)
  }
  return midi.toArray()
}
