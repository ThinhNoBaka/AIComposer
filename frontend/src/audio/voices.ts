// Bộ phát âm thanh cho một AudioContext (phát trực tiếp) hoặc OfflineAudioContext (render WAV).
// Sample thật lấy từ smplr; trong lúc đang tải hoặc khi tải lỗi thì tự dùng synth dự phòng.

import { DrumMachine, Soundfont, type Smplr } from 'smplr'
import type { DrumSound } from '../core/accompany'
import { CUSTOM_SYNTH, DEFAULT_SYNTH, trackEq, trackPan, trackReverb, vocalOffsetSec, type MixSettings, type Song, type SynthPreset, type TrackId, type VocalTrack } from '../core/song'
import { vocalStartPlan } from '../core/vocal'
import { getFx, type FxDef } from './fx'
import { customSynthNote, makeImpulse, synthDrum, synthFx, synthNote, type SynthFlavor } from './synth'
import { loadVocalBuffer, vocalKey } from './vocalCache'

export type Bus = TrackId | 'fx' | 'vocal'

/** Chuỗi xử lý của một track: âm lượng → EQ 3 dải → pan → master, và nhánh gửi sang tiếng vang. */
type Strip = { gain: GainNode; low: BiquadFilterNode; mid: BiquadFilterNode; high: BiquadFilterNode; pan: StereoPannerNode; send: GainNode }

function setParam(p: AudioParam, v: number) {
  if (Math.abs(p.value - v) > 1e-4) p.value = v
}
export type LoadState = 'loading' | 'ready' | 'fallback'

type DrumInstance = ReturnType<typeof DrumMachine>

const LOAD_TIMEOUT_MS = 20000

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

const FLAVOR: Record<Exclude<TrackId, 'drums'>, SynthFlavor> = { melody: 'lead', chords: 'keys', bass: 'bass' }

// Tên nhóm tiếng trống trong các bộ trống khác nhau không giống nhau: dò theo mẫu.
const DRUM_PATTERNS: Record<DrumSound, RegExp[]> = {
  kick: [/kick/i, /\bbd\b/i, /bass.?drum/i],
  snare: [/snare/i, /\bsd\b/i],
  clap: [/clap/i, /\bcp\b/i, /snare/i],
  'hihat-close': [/(hi.?hat|hh).*(clos)/i, /clos.*(hat)/i, /\bch\b/i, /hi.?hat/i, /\bhh\b/i],
  'hihat-open': [/(hi.?hat|hh).*open/i, /open/i, /\boh\b/i, /hi.?hat/i],
  'tom-low': [/tom.*(low|lo)\b/i, /low.*tom/i, /\blt\b/i, /tom/i, /conga/i],
  'tom-mid': [/tom.*(mid|med)/i, /mid.*tom/i, /\bmt\b/i, /tom/i, /conga/i],
  'tom-high': [/tom.*(hi|high)/i, /high.*tom/i, /\bht\b/i, /tom/i, /conga/i],
  crash: [/crash/i, /cymbal/i, /\bcy\b/i, /ride/i],
}

export function mapDrumGroups(groups: string[]): Partial<Record<DrumSound, string>> {
  const out: Partial<Record<DrumSound, string>> = {}
  for (const sound of Object.keys(DRUM_PATTERNS) as DrumSound[]) {
    for (const re of DRUM_PATTERNS[sound]) {
      const hit = groups.find((g) => re.test(g))
      if (hit) {
        out[sound] = hit
        break
      }
    }
  }
  return out
}

type SfEntry = { inst: Smplr | null; state: LoadState; promise: Promise<void> }

export class Voices {
  readonly ctx: BaseAudioContext
  private master: GainNode
  private strips: Record<Bus, Strip>
  private buses: Record<Bus, GainNode>
  private live: Record<Bus, GainNode>
  private sf = new Map<string, SfEntry>()
  private current: Record<Exclude<TrackId, 'drums'>, string> = { melody: '', chords: '', bass: '' }
  private presets: Record<Exclude<TrackId, 'drums'>, SynthPreset> = { melody: DEFAULT_SYNTH, chords: DEFAULT_SYNTH, bass: DEFAULT_SYNTH }
  private vocal: { key: string; offsetSec: number; buffer: AudioBuffer | null; promise: Promise<void> } | null = null
  private vocalSources: AudioBufferSourceNode[] = []
  private drum: { kit: string; inst: DrumInstance | null; map: Partial<Record<DrumSound, string>>; state: LoadState; promise: Promise<void> } | null = null
  customFx: FxDef[] = []
  customBuffers = new Map<string, AudioBuffer>()
  onStatus?: () => void

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -10
    comp.ratio.value = 4
    comp.connect(ctx.destination)
    this.master = ctx.createGain()
    this.master.gain.value = 0.9
    this.master.connect(comp)
    const reverb = ctx.createConvolver()
    reverb.buffer = makeImpulse(ctx)
    const wet = ctx.createGain()
    wet.gain.value = 0.22
    reverb.connect(wet).connect(this.master)
    const mk = (send: number): Strip => {
      const gain = ctx.createGain()
      const low = ctx.createBiquadFilter()
      low.type = 'lowshelf'
      low.frequency.value = 250
      low.gain.value = 0
      const mid = ctx.createBiquadFilter()
      mid.type = 'peaking'
      mid.frequency.value = 1000
      mid.Q.value = 0.8
      mid.gain.value = 0
      const high = ctx.createBiquadFilter()
      high.type = 'highshelf'
      high.frequency.value = 4000
      high.gain.value = 0
      const pan = ctx.createStereoPanner()
      pan.pan.value = 0
      const sendGain = ctx.createGain()
      sendGain.gain.value = send
      gain.connect(low).connect(mid).connect(high).connect(pan)
      pan.connect(this.master)
      pan.connect(sendGain).connect(reverb)
      return { gain, low, mid, high, pan, send: sendGain }
    }
    this.strips = { melody: mk(0.5), chords: mk(0.6), bass: mk(0), drums: mk(0.15), fx: mk(0.5), vocal: mk(0.3) }
    this.buses = Object.fromEntries(Object.entries(this.strips).map(([k, st]) => [k, st.gain])) as Record<Bus, GainNode>
    this.live = this.makeLive()
  }

  private makeLive(): Record<Bus, GainNode> {
    const out = {} as Record<Bus, GainNode>
    for (const b of Object.keys(this.buses) as Bus[]) {
      const g = this.ctx.createGain()
      g.connect(this.buses[b])
      out[b] = g
    }
    return out
  }

  /** Trạng thái tải của từng track, để giao diện hiển thị. */
  status(): Record<TrackId, LoadState> {
    const st = (track: Exclude<TrackId, 'drums'>): LoadState =>
      this.current[track] === CUSTOM_SYNTH ? 'ready' : (this.sf.get(`${track}|${this.current[track]}`)?.state ?? 'loading')
    return { melody: st('melody'), chords: st('chords'), bass: st('bass'), drums: this.drum?.state ?? 'loading' }
  }

  private loadSoundfont(bus: Bus, name: string): Promise<void> {
    const key = `${bus}|${name}`
    const existing = this.sf.get(key)
    if (existing) return existing.promise
    const entry: SfEntry = { inst: null, state: 'loading', promise: Promise.resolve() }
    entry.promise = (async () => {
      try {
        const inst = Soundfont(this.ctx, { instrument: name, kit: 'FluidR3_GM', destination: this.buses[bus] })
        await withTimeout(inst.ready, LOAD_TIMEOUT_MS)
        const p = inst.loadProgress
        if (p.total > 0 && p.loaded === 0) throw new Error('no samples')
        entry.inst = inst
        entry.state = 'ready'
      } catch {
        entry.state = 'fallback'
      }
      this.onStatus?.()
    })()
    this.sf.set(key, entry)
    this.onStatus?.()
    return entry.promise
  }

  setTrackInstrument(track: Exclude<TrackId, 'drums'>, name: string): Promise<void> {
    if (this.current[track] !== name) {
      this.current[track] = name
      if (name === CUSTOM_SYNTH) this.onStatus?.()
    }
    if (name === CUSTOM_SYNTH) return Promise.resolve()
    return this.loadSoundfont(track, name)
  }

  /** Nạp bản thu giọng (gốc hoặc đã chỉnh) của bài; không có giọng thì bỏ. */
  setVocal(v: VocalTrack | undefined): Promise<void> {
    if (!v) {
      this.vocal = null
      return Promise.resolve()
    }
    const key = vocalKey(v)
    if (this.vocal?.key === key) {
      this.vocal.offsetSec = vocalOffsetSec(v)
      return this.vocal.promise
    }
    const entry = { key, offsetSec: vocalOffsetSec(v), buffer: null as AudioBuffer | null, promise: Promise.resolve() }
    entry.promise = loadVocalBuffer(v).then(
      (buf) => {
        entry.buffer = buf
        this.onStatus?.()
      },
      () => {
        entry.buffer = null
        this.onStatus?.()
      },
    )
    this.vocal = entry
    return entry.promise
  }

  /** Bản thu giọng đã nạp xong chưa (null = bài không có giọng). */
  vocalReady(): boolean | null {
    return this.vocal ? !!this.vocal.buffer : null
  }

  /** Phát bản thu từ đầu (bỏ qua `skip` giây đầu) tại thời điểm `time`. Chỉ một bản thu vang cùng lúc. */
  vocalStart(time: number, skip = 0) {
    const buf = this.vocal?.buffer
    if (!buf || skip >= buf.duration) return
    this.stopVocal(time)
    const node = this.ctx.createBufferSource()
    node.buffer = buf
    node.connect(this.live.vocal)
    node.start(time, skip)
    node.onended = () => {
      this.vocalSources = this.vocalSources.filter((x) => x !== node)
    }
    this.vocalSources.push(node)
  }

  /** Bắt đầu phát bài ở giữa bản thu: phát tiếp bản thu từ đúng chỗ. `songPosSec` là vị trí trong bài lúc `time`. */
  vocalFrom(time: number, songPosSec: number) {
    const v = this.vocal
    if (!v?.buffer) return
    const plan = vocalStartPlan(songPosSec, v.offsetSec, v.buffer.duration)
    if (plan && plan.delay === 0) this.vocalStart(time, plan.bufOffset)
  }

  /** Vòng lặp quay lại: dừng bản thu đang vang lúc `time`, rồi phát tiếp nếu vị trí `songPosSec` nằm giữa bản thu. */
  vocalWrap(time: number, songPosSec: number) {
    this.stopVocal(time)
    this.vocalFrom(time, songPosSec)
  }

  private stopVocal(at?: number) {
    for (const n of this.vocalSources) {
      try {
        n.stop(at)
      } catch {
        /* đã dừng */
      }
    }
    this.vocalSources = []
  }

  setDrumKit(kit: string): Promise<void> {
    if (this.drum?.kit === kit) return this.drum.promise
    const d = { kit, inst: null as DrumInstance | null, map: {} as Partial<Record<DrumSound, string>>, state: 'loading' as LoadState, promise: Promise.resolve() }
    d.promise = (async () => {
      try {
        const inst = DrumMachine(this.ctx, { instrument: kit, destination: this.buses.drums })
        await withTimeout(inst.ready, LOAD_TIMEOUT_MS)
        d.map = mapDrumGroups(inst.getGroupNames())
        if (!d.map.kick && !d.map.snare) throw new Error('kit trống không có tiếng cơ bản')
        d.inst = inst
        d.state = 'ready'
      } catch {
        d.state = 'fallback'
      }
      this.onStatus?.()
    })()
    this.drum = d
    this.onStatus?.()
    return d.promise
  }

  /** Tải sẵn các nhạc cụ GM mà hiệu ứng trong bài cần. */
  prepareFx(ids: string[]): Promise<void> {
    const jobs: Promise<void>[] = []
    for (const id of new Set(ids)) {
      const def = getFx(id, this.customFx)
      if (def?.source.type === 'gm') jobs.push(this.loadSoundfont('fx', def.source.instrument))
    }
    return Promise.all(jobs).then(() => undefined)
  }

  /** Tải mọi thứ bài cần. Dùng trước khi render WAV. */
  async prepareSong(song: Song): Promise<void> {
    await Promise.all([
      this.setTrackInstrument('melody', song.tracks.melody.instrument),
      this.setTrackInstrument('chords', song.tracks.chords.instrument),
      this.setTrackInstrument('bass', song.tracks.bass.instrument),
      this.setDrumKit(song.tracks.drums.instrument),
      this.prepareFx(song.fx.map((f) => f.fx)),
      this.setVocal(song.vocal),
    ])
  }

  private applyMix(bus: Bus, m: MixSettings, id: TrackId | 'vocal') {
    const st = this.strips[bus]
    setParam(st.gain.gain, m.muted ? 0 : m.volume)
    const eq = trackEq(m)
    setParam(st.low.gain, eq.low)
    setParam(st.mid.gain, eq.mid)
    setParam(st.high.gain, eq.high)
    setParam(st.pan.pan, trackPan(m))
    setParam(st.send.gain, trackReverb(m, id))
  }

  /** Âm lượng, pan, EQ, vang và âm sắc synth của mọi track theo bài. Gọi thường xuyên được (chỉ đổi khi khác). */
  setVolumes(song: Song) {
    for (const t of ['melody', 'chords', 'bass', 'drums'] as const) this.applyMix(t, song.tracks[t], t)
    for (const t of ['melody', 'chords', 'bass'] as const) this.presets[t] = song.tracks[t].synth ?? DEFAULT_SYNTH
    setParam(this.strips.fx.gain.gain, song.fxVolume)
    if (song.vocal) {
      this.applyMix('vocal', song.vocal, 'vocal')
      if (this.vocal) this.vocal.offsetSec = vocalOffsetSec(song.vocal)
    } else setParam(this.strips.vocal.gain.gain, 0)
  }

  note(track: Exclude<TrackId, 'drums'>, pitch: number, time: number, durSec: number, vel: number) {
    if (this.current[track] === CUSTOM_SYNTH) {
      customSynthNote(this.ctx, this.live[track], this.presets[track], pitch, time, durSec, vel)
      return
    }
    const entry = this.sf.get(`${track}|${this.current[track]}`)
    if (entry?.inst) {
      entry.inst.start({ note: pitch, time, duration: durSec, velocity: vel })
    } else {
      synthNote(this.ctx, this.live[track], pitch, time, durSec, vel, FLAVOR[track])
    }
  }

  drumHit(sound: DrumSound, time: number, vel: number) {
    const d = this.drum
    const group = d?.map[sound]
    if (d?.inst && group) d.inst.start({ note: group, time, velocity: vel })
    else synthDrum(this.ctx, this.live.drums, sound, time, vel)
  }

  fx(id: string, time: number) {
    const def = getFx(id, this.customFx)
    if (!def) return
    const src = def.source
    if (src.type === 'synth') {
      synthFx(this.ctx, this.live.fx, src.id, time)
    } else if (src.type === 'gm') {
      const entry = this.sf.get(`fx|${src.instrument}`)
      if (entry?.inst) entry.inst.start({ note: src.note, time, duration: src.dur, velocity: 110 })
      else if (!entry) void this.loadSoundfont('fx', src.instrument)
    } else {
      const buf = this.customBuffers.get(id)
      if (!buf) return
      const node = this.ctx.createBufferSource()
      node.buffer = buf
      node.connect(this.live.fx)
      node.start(time)
    }
  }

  /** Dừng mọi tiếng đang kêu hoặc đã hẹn giờ. */
  stopAll() {
    for (const e of this.sf.values()) e.inst?.stop()
    this.drum?.inst?.stop()
    this.stopVocal()
    for (const g of Object.values(this.live)) g.disconnect()
    this.live = this.makeLive()
  }

  dispose() {
    this.stopAll()
    for (const e of this.sf.values()) e.inst?.dispose()
    this.drum?.inst?.dispose()
  }
}
