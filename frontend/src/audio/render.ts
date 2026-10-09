import { renderOffline } from 'smplr'
import { buildEvents } from '../core/events'
import { STEPS_PER_BAR, stepSeconds, type Song } from '../core/song'
import type { FxDef } from './fx'
import { scheduleEvent } from './player'
import { Voices } from './voices'

/** Độ dài mỗi khúc lên lịch khi render (giây). */
const CHUNK = 4

/**
 * Render bài ra WAV bằng OfflineAudioContext (nhanh hơn thời gian thực).
 * `loops` = số lần lặp vòng; thêm 3 giây đuôi cho tiếng vang tắt hẳn.
 */
export async function renderSongToWav(
  song: Song,
  opts: { loops?: number; customFx?: FxDef[]; customBuffers?: Map<string, AudioBuffer> } = {},
): Promise<{ blob: Blob; usedFallback: boolean; vocalMissing: boolean }> {
  const loops = opts.loops ?? 1
  const stepSec = stepSeconds(song.bpm)
  const loopSteps = song.bars * STEPS_PER_BAR
  const duration = loops * loopSteps * stepSec + 3
  let usedFallback = false
  let vocalMissing = false
  const result = await renderOffline(
    async (ctx) => {
      const v = new Voices(ctx)
      v.customFx = opts.customFx ?? []
      v.customBuffers = opts.customBuffers ?? new Map()
      await v.prepareSong(song)
      usedFallback = Object.values(v.status()).some((s) => s === 'fallback')
      vocalMissing = !!song.vocal && !song.vocal.muted && v.vocalReady() === false
      v.setVolumes(song)
      const events = buildEvents(song)
      const timed: { t: number; e: (typeof events)[number] }[] = []
      for (let k = 0; k < loops; k++) for (const e of events) timed.push({ t: 0.05 + (k * loopSteps + e.start) * stepSec, e })
      timed.sort((a, b) => a.t - b.t)
      // Lên lịch theo từng khúc CHUNK giây thay vì tạo hết node một lúc: nếu tạo hết từ đầu, mọi node
      // (filter, gain) của cả bài cùng sống trong đồ thị và chi phí render tăng theo bình phương độ dài bài.
      let next = 0
      const scheduleUntil = (until: number) => {
        while (next < timed.length && timed[next].t < until) {
          scheduleEvent(v, timed[next].e, timed[next].t, stepSec)
          next++
        }
      }
      scheduleUntil(2 * CHUNK)
      for (let t = CHUNK; t < duration && next < timed.length; t += CHUNK) {
        const at = t
        const off = ctx as OfflineAudioContext
        off.suspend(at).then(() => {
          scheduleUntil(at + 2 * CHUNK)
          void off.resume()
        })
      }
    },
    { duration, sampleRate: 44100, channels: 2 },
  )
  return { blob: result.toWav16(), usedFallback, vocalMissing }
}
