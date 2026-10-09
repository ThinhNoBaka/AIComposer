// Tách bài thành từng track riêng (stems) để xuất WAV: mỗi stem là bài chỉ còn một track kêu.

import { buildEvents } from './events'
import type { Song, TrackId } from './song'

export type StemId = TrackId | 'fx' | 'vocal'

export const STEM_LABEL: Record<StemId, string> = {
  melody: 'giai-dieu',
  chords: 'hop-am',
  bass: 'bass',
  drums: 'trong',
  fx: 'hieu-ung',
  vocal: 'giong-hat',
}

const TRACKS: TrackId[] = ['melody', 'chords', 'bass', 'drums']

/** Bài chỉ còn track `id` (giữ nguyên âm lượng, pan, EQ, vang của track đó). */
export function soloSong(song: Song, id: StemId): Song {
  const tracks = { ...song.tracks }
  for (const t of TRACKS) if (t !== id) tracks[t] = { ...tracks[t], muted: true }
  return {
    ...song,
    tracks,
    fx: id === 'fx' ? song.fx : [],
    vocal: song.vocal && id !== 'vocal' ? { ...song.vocal, muted: true } : song.vocal,
  }
}

/** Các stem có tiếng trong bản mix hiện tại (track tắt tiếng hoặc không có nốt thì bỏ). */
export function stemIds(song: Song): StemId[] {
  const ev = buildEvents(song)
  const has = (track: string) => ev.some((e) => e.track === track)
  const out: StemId[] = TRACKS.filter((t) => has(t))
  if (song.fx.length && song.fxVolume > 0) out.push('fx')
  if (has('vocal')) out.push('vocal')
  return out
}
