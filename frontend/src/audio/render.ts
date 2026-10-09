import { renderOffline } from 'smplr'
import { buildEvents } from '../core/events'
import { STEPS_PER_BAR, stepSeconds, type Song } from '../core/song'
import type { FxDef } from './fx'
import { scheduleEvent } from './player'
import { Voices } from './voices'

/**
 * Render bài ra WAV bằng OfflineAudioContext (nhanh hơn thời gian thực).
 * `loops` = số lần lặp vòng; thêm 3 giây đuôi cho tiếng vang tắt hẳn.
 */
export async function renderSongToWav(
  song: Song,
  opts: { loops?: number; customFx?: FxDef[]; customBuffers?: Map<string, AudioBuffer> } = {},
): Promise<{ blob: Blob; usedFallback: boolean }> {
  const loops = opts.loops ?? 1
  const stepSec = stepSeconds(song.bpm)
  const loopSteps = song.bars * STEPS_PER_BAR
  const duration = loops * loopSteps * stepSec + 3
  let usedFallback = false
  const result = await renderOffline(
    async (ctx) => {
      const v = new Voices(ctx)
      v.customFx = opts.customFx ?? []
      v.customBuffers = opts.customBuffers ?? new Map()
      await v.prepareSong(song)
      usedFallback = Object.values(v.status()).some((s) => s === 'fallback')
      v.setVolumes(song)
      const events = buildEvents(song)
      for (let k = 0; k < loops; k++) {
        for (const e of events) scheduleEvent(v, e, 0.05 + (k * loopSteps + e.start) * stepSec, stepSec)
      }
    },
    { duration, sampleRate: 44100, channels: 2 },
  )
  return { blob: result.toWav16(), usedFallback }
}
