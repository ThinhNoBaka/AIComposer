// Phát nhạc lặp vòng theo kiểu "lookahead scheduler": cứ 25 ms hẹn giờ trước các nốt
// sẽ vang trong 150 ms tới, theo đồng hồ chính xác của AudioContext.

import { buildEvents, type PlayEvent } from '../core/events'
import { STEPS_PER_BAR, stepSeconds, type Song } from '../core/song'
import { Voices } from './voices'

const LOOKAHEAD_SEC = 0.15
const TICK_MS = 25

export function scheduleEvent(v: Voices, e: PlayEvent, time: number, stepSec: number) {
  if (e.kind === 'note') v.note(e.track, e.pitch, time, e.dur * stepSec, e.vel)
  else if (e.kind === 'drum') v.drumHit(e.sound, time, e.vel)
  else v.fx(e.fx, time)
}

export class Player {
  private ctx: AudioContext | null = null
  voices: Voices | null = null
  private timer: number | null = null
  private getSong: () => Song = () => {
    throw new Error('chưa có bài')
  }
  private anchorTime = 0
  private anchorStep = 0
  private scheduledUpTo = 0
  private bpm = 120
  private cachedSong: Song | null = null
  private cachedEvents: PlayEvent[] = []
  playing = false
  onStatus?: () => void

  /** Tạo AudioContext ở lần bấm đầu tiên (trình duyệt chặn âm thanh trước khi người dùng tương tác). */
  async ensure(): Promise<Voices> {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' })
      this.voices = new Voices(this.ctx)
      this.voices.onStatus = () => this.onStatus?.()
    }
    if (this.ctx.state !== 'running') await this.ctx.resume()
    return this.voices!
  }

  get context(): AudioContext | null {
    return this.ctx
  }

  /** Đồng bộ nhạc cụ và âm lượng với bài; gọi mỗi khi bài đổi. */
  sync(song: Song) {
    const v = this.voices
    if (!v) return
    void v.setTrackInstrument('melody', song.tracks.melody.instrument)
    void v.setTrackInstrument('chords', song.tracks.chords.instrument)
    void v.setTrackInstrument('bass', song.tracks.bass.instrument)
    void v.setDrumKit(song.tracks.drums.instrument)
    void v.prepareFx(song.fx.map((f) => f.fx))
    v.setVolumes(song)
  }

  async play(getSong: () => Song, fromStep = 0) {
    await this.ensure()
    this.stop()
    this.getSong = getSong
    const song = getSong()
    this.sync(song)
    this.bpm = song.bpm
    this.anchorTime = this.ctx!.currentTime + 0.08
    this.anchorStep = fromStep
    this.scheduledUpTo = fromStep
    this.playing = true
    this.tick()
    this.timer = window.setInterval(() => this.tick(), TICK_MS)
  }

  stop() {
    if (this.timer !== null) window.clearInterval(this.timer)
    this.timer = null
    if (this.playing) this.voices?.stopAll()
    this.playing = false
  }

  private events(song: Song): PlayEvent[] {
    if (song !== this.cachedSong) {
      this.cachedSong = song
      this.cachedEvents = buildEvents(song)
    }
    return this.cachedEvents
  }

  /** Vị trí hiện tại tính bằng bước, tuyệt đối (chưa chia lấy dư theo độ dài vòng). */
  private absStep(time: number): number {
    return this.anchorStep + (time - this.anchorTime) / stepSeconds(this.bpm)
  }

  /** Vị trí đầu phát trong vòng, để vẽ vạch chạy trên piano roll. */
  position(): number | null {
    if (!this.playing || !this.ctx || !this.cachedSong) return null
    const total = this.cachedSong.bars * STEPS_PER_BAR
    const s = this.absStep(this.ctx.currentTime)
    if (s < 0) return 0
    return s % total
  }

  private tick() {
    if (!this.ctx || !this.voices) return
    const song = this.getSong()
    const now = this.ctx.currentTime
    if (song.bpm !== this.bpm) {
      // Đổi tempo khi đang phát: neo lại tại bước kế tiếp chưa hẹn giờ, tính theo tempo cũ,
      // rồi từ đó trở đi chạy theo tempo mới. Không bỏ sót hay lặp nốt nào.
      const t = this.anchorTime + (this.scheduledUpTo - this.anchorStep) * stepSeconds(this.bpm)
      this.anchorStep = this.scheduledUpTo
      this.anchorTime = t
      this.bpm = song.bpm
    }
    this.voices.setVolumes(song)
    const total = song.bars * STEPS_PER_BAR
    const stepSec = stepSeconds(this.bpm)
    const target = this.absStep(now + LOOKAHEAD_SEC)
    if (target <= this.scheduledUpTo) return
    const events = this.events(song)
    const from = this.scheduledUpTo
    for (let k = Math.floor(from / total); k <= Math.floor(target / total); k++) {
      for (const e of events) {
        const abs = k * total + e.start
        if (abs >= from && abs < target) {
          scheduleEvent(this.voices, e, this.anchorTime + (abs - this.anchorStep) * stepSec, stepSec)
        }
      }
    }
    this.scheduledUpTo = target
  }
}
