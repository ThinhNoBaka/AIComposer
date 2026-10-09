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
  /** Vùng lặp [start, end) tính bằng bước; null = lặp cả bài. */
  private loop: { start: number; end: number } | null = null
  /** Tiếng gõ mỗi phách khi phát (chỉ nghe lúc phát, không có trong file xuất). */
  metronome = false

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

  /** Đặt vùng lặp. Đổi khi đang phát thì nơi gọi nên phát lại từ vị trí hiện tại. */
  setLoop(loop: { start: number; end: number } | null) {
    this.loop = loop && loop.end > loop.start ? loop : null
  }

  /** Vùng đang lặp, đã cắt cho nằm trong bài. */
  private range(song: Song): { start: number; len: number } {
    const total = song.bars * STEPS_PER_BAR
    const l = this.loop
    if (l && l.start < total) {
      const end = Math.min(total, l.end)
      return { start: l.start, len: end - l.start }
    }
    return { start: 0, len: total }
  }

  async play(getSong: () => Song, fromStep = 0) {
    await this.ensure()
    this.stop()
    this.getSong = getSong
    const song = getSong()
    this.sync(song)
    this.bpm = song.bpm
    const r = this.range(song)
    // Chỗ bắt đầu nằm ngoài vùng lặp thì phát từ đầu vùng lặp.
    if (fromStep < r.start || fromStep >= r.start + r.len) fromStep = r.start
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
    const r = this.range(this.cachedSong)
    const s = this.absStep(this.ctx.currentTime)
    if (s < r.start) return Math.max(0, s)
    return r.start + ((s - r.start) % r.len)
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
    const { start: ls, len } = this.range(song)
    const stepSec = stepSeconds(this.bpm)
    const target = this.absStep(now + LOOKAHEAD_SEC)
    if (target <= this.scheduledUpTo) return
    const events = this.events(song)
    const from = this.scheduledUpTo
    // Bước tuyệt đối abs ứng với vị trí ls + (abs - ls) mod len trong bài: mỗi vòng k dịch đi k*len bước.
    const at = (abs: number) => this.anchorTime + (abs - this.anchorStep) * stepSec
    for (let k = Math.floor((from - ls) / len); k <= Math.floor((target - ls) / len); k++) {
      for (const e of events) {
        if (e.start < ls || e.start >= ls + len) continue
        const abs = ls + k * len + (e.start - ls)
        if (abs >= from && abs < target) scheduleEvent(this.voices, e, at(abs), stepSec)
      }
      if (this.metronome) {
        for (let st = Math.ceil(ls / 4) * 4; st < ls + len; st += 4) {
          const abs = ls + k * len + (st - ls)
          if (abs >= from && abs < target) this.click(at(abs), st % STEPS_PER_BAR === 0)
        }
      }
    }
    this.scheduledUpTo = target
  }

  /** Tiếng gõ máy đếm nhịp: phách đầu ô cao hơn. Đi thẳng ra loa, không qua bộ trộn của bài. */
  private click(time: number, downbeat: boolean) {
    const ctx = this.ctx!
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.frequency.value = downbeat ? 1760 : 1175
    g.gain.setValueAtTime(0.0001, time)
    g.gain.exponentialRampToValueAtTime(0.35, time + 0.003)
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.06)
    osc.connect(g).connect(ctx.destination)
    osc.start(time)
    osc.stop(time + 0.07)
  }
}
