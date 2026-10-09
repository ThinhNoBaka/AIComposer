// Âm thanh tổng hợp bằng Web Audio: synth dự phòng khi chưa tải được sample,
// trống tổng hợp, và các hiệu ứng tự tạo (không cần file, không vướng bản quyền).
// Mọi hàm nhận BaseAudioContext nên chạy được cả khi phát trực tiếp lẫn khi render WAV.

import type { DrumSound } from '../core/accompany'

const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>()

function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  let buf = noiseCache.get(ctx)
  if (!buf) {
    buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
    noiseCache.set(ctx, buf)
  }
  return buf
}

function noise(ctx: BaseAudioContext, time: number, dur: number, loop = true): AudioBufferSourceNode {
  const src = ctx.createBufferSource()
  src.buffer = noiseBuffer(ctx)
  src.loop = loop
  src.start(time)
  src.stop(time + dur + 0.05)
  return src
}

function env(ctx: BaseAudioContext, time: number, attack: number, peak: number, release: number, hold = 0): GainNode {
  const g = ctx.createGain()
  g.gain.setValueAtTime(0.0001, time)
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), time + attack)
  g.gain.setValueAtTime(Math.max(0.0002, peak), time + attack + hold)
  g.gain.exponentialRampToValueAtTime(0.0001, time + attack + hold + release)
  return g
}

export type SynthFlavor = 'lead' | 'keys' | 'bass' | 'pad'

/** Synth dự phòng: phát được ngay, không cần tải gì. */
export function synthNote(
  ctx: BaseAudioContext,
  dest: AudioNode,
  pitch: number,
  time: number,
  dur: number,
  vel: number,
  flavor: SynthFlavor,
) {
  const freq = 440 * Math.pow(2, (pitch - 69) / 12)
  const amp = (vel / 127) * (flavor === 'bass' ? 0.5 : flavor === 'pad' ? 0.18 : 0.28)
  const osc = ctx.createOscillator()
  osc.type = flavor === 'bass' ? 'triangle' : flavor === 'lead' ? 'sawtooth' : flavor === 'pad' ? 'sawtooth' : 'triangle'
  osc.frequency.setValueAtTime(freq, time)
  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.setValueAtTime(flavor === 'bass' ? 700 : flavor === 'lead' ? 2600 : 1800, time)
  const attack = flavor === 'pad' ? 0.25 : 0.008
  const release = flavor === 'pad' ? 0.6 : 0.25
  const g = env(ctx, time, attack, amp, release, Math.max(0, dur - attack))
  osc.connect(filter).connect(g).connect(dest)
  osc.start(time)
  osc.stop(time + attack + dur + release + 0.05)
}

/** Trống tổng hợp, dùng khi bộ trống sample chưa sẵn sàng hoặc thiếu tiếng. */
export function synthDrum(ctx: BaseAudioContext, dest: AudioNode, sound: DrumSound, time: number, vel: number) {
  const amp = vel / 127
  const tom = (f0: number) => {
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(f0, time)
    o.frequency.exponentialRampToValueAtTime(f0 * 0.5, time + 0.25)
    o.connect(env(ctx, time, 0.003, amp * 0.8, 0.3)).connect(dest)
    o.start(time)
    o.stop(time + 0.4)
  }
  const hiss = (type: BiquadFilterType, freq: number, peak: number, release: number) => {
    const f = ctx.createBiquadFilter()
    f.type = type
    f.frequency.value = freq
    noise(ctx, time, release + 0.05).connect(f).connect(env(ctx, time, 0.002, peak, release)).connect(dest)
  }
  switch (sound) {
    case 'kick': {
      const o = ctx.createOscillator()
      o.type = 'sine'
      o.frequency.setValueAtTime(150, time)
      o.frequency.exponentialRampToValueAtTime(42, time + 0.12)
      o.connect(env(ctx, time, 0.002, amp, 0.35)).connect(dest)
      o.start(time)
      o.stop(time + 0.45)
      break
    }
    case 'snare':
      hiss('bandpass', 1800, amp * 0.7, 0.18)
      tom(220)
      break
    case 'clap':
      for (const dt of [0, 0.012, 0.024]) {
        const f = ctx.createBiquadFilter()
        f.type = 'bandpass'
        f.frequency.value = 1200
        noise(ctx, time + dt, 0.12).connect(f).connect(env(ctx, time + dt, 0.001, amp * 0.6, 0.1)).connect(dest)
      }
      break
    case 'hihat-close':
      hiss('highpass', 7000, amp * 0.35, 0.05)
      break
    case 'hihat-open':
      hiss('highpass', 6500, amp * 0.3, 0.3)
      break
    case 'crash':
      hiss('highpass', 4500, amp * 0.35, 1.4)
      break
    case 'tom-low':
      tom(110)
      break
    case 'tom-mid':
      tom(160)
      break
    case 'tom-high':
      tom(220)
      break
  }
}

// ----- Hiệu ứng tự tạo -----

export type SynthFxId = 'riser' | 'downlifter' | 'impact' | 'whoosh' | 'rain' | 'wind' | 'vinyl' | 'heartbeat' | 'clock' | 'subdrop'

export function synthFx(ctx: BaseAudioContext, dest: AudioNode, id: SynthFxId, time: number) {
  switch (id) {
    case 'riser': {
      const dur = 3.5
      const f = ctx.createBiquadFilter()
      f.type = 'bandpass'
      f.Q.value = 4
      f.frequency.setValueAtTime(300, time)
      f.frequency.exponentialRampToValueAtTime(9000, time + dur)
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, time)
      g.gain.exponentialRampToValueAtTime(0.5, time + dur)
      g.gain.exponentialRampToValueAtTime(0.0001, time + dur + 0.08)
      noise(ctx, time, dur + 0.1).connect(f).connect(g).connect(dest)
      break
    }
    case 'downlifter': {
      const dur = 2.5
      const f = ctx.createBiquadFilter()
      f.type = 'bandpass'
      f.Q.value = 3
      f.frequency.setValueAtTime(8000, time)
      f.frequency.exponentialRampToValueAtTime(200, time + dur)
      noise(ctx, time, dur).connect(f).connect(env(ctx, time, 0.01, 0.45, dur)).connect(dest)
      break
    }
    case 'impact': {
      const o = ctx.createOscillator()
      o.type = 'sine'
      o.frequency.setValueAtTime(90, time)
      o.frequency.exponentialRampToValueAtTime(30, time + 1.2)
      o.connect(env(ctx, time, 0.003, 0.9, 1.6)).connect(dest)
      o.start(time)
      o.stop(time + 1.8)
      const f = ctx.createBiquadFilter()
      f.type = 'lowpass'
      f.frequency.value = 2500
      noise(ctx, time, 1).connect(f).connect(env(ctx, time, 0.002, 0.5, 0.9)).connect(dest)
      break
    }
    case 'whoosh': {
      const dur = 1.2
      const f = ctx.createBiquadFilter()
      f.type = 'bandpass'
      f.Q.value = 2
      f.frequency.setValueAtTime(400, time)
      f.frequency.exponentialRampToValueAtTime(4000, time + dur * 0.6)
      f.frequency.exponentialRampToValueAtTime(800, time + dur)
      noise(ctx, time, dur).connect(f).connect(env(ctx, time, dur * 0.6, 0.5, dur * 0.4)).connect(dest)
      break
    }
    case 'rain': {
      const dur = 8
      const f = ctx.createBiquadFilter()
      f.type = 'highpass'
      f.frequency.value = 1500
      noise(ctx, time, dur).connect(f).connect(env(ctx, time, 1, 0.22, 1.5, dur - 2.5)).connect(dest)
      // Giọt mưa: những tiếng tách ngẫu nhiên.
      for (let i = 0; i < 70; i++) {
        const t = time + Math.random() * (dur - 0.5)
        const d = ctx.createBiquadFilter()
        d.type = 'bandpass'
        d.frequency.value = 2500 + Math.random() * 3000
        noise(ctx, t, 0.03).connect(d).connect(env(ctx, t, 0.001, 0.15 + Math.random() * 0.15, 0.02)).connect(dest)
      }
      break
    }
    case 'wind': {
      const dur = 7
      const f = ctx.createBiquadFilter()
      f.type = 'bandpass'
      f.Q.value = 6
      f.frequency.setValueAtTime(400, time)
      for (let k = 1; k <= 7; k++) f.frequency.linearRampToValueAtTime(300 + Math.random() * 900, time + k)
      noise(ctx, time, dur).connect(f).connect(env(ctx, time, 1.5, 0.5, 2, dur - 3.5)).connect(dest)
      break
    }
    case 'vinyl': {
      const dur = 8
      const f = ctx.createBiquadFilter()
      f.type = 'bandpass'
      f.frequency.value = 3000
      noise(ctx, time, dur).connect(f).connect(env(ctx, time, 0.3, 0.04, 0.5, dur - 0.8)).connect(dest)
      for (let i = 0; i < 90; i++) {
        const t = time + Math.random() * dur
        const c = ctx.createBiquadFilter()
        c.type = 'highpass'
        c.frequency.value = 2000
        noise(ctx, t, 0.01).connect(c).connect(env(ctx, t, 0.0005, 0.08 + Math.random() * 0.25, 0.006)).connect(dest)
      }
      break
    }
    case 'heartbeat': {
      for (let beat = 0; beat < 4; beat++) {
        for (const [dt, a] of [[0, 0.9], [0.22, 0.6]] as const) {
          const t = time + beat * 0.85 + dt
          const o = ctx.createOscillator()
          o.type = 'sine'
          o.frequency.setValueAtTime(70, t)
          o.frequency.exponentialRampToValueAtTime(40, t + 0.12)
          o.connect(env(ctx, t, 0.005, a, 0.18)).connect(dest)
          o.start(t)
          o.stop(t + 0.25)
        }
      }
      break
    }
    case 'clock': {
      for (let i = 0; i < 8; i++) {
        const t = time + i * 0.5
        const o = ctx.createOscillator()
        o.type = 'square'
        o.frequency.value = i % 2 === 0 ? 2400 : 1900
        const f = ctx.createBiquadFilter()
        f.type = 'bandpass'
        f.frequency.value = 2200
        o.connect(f).connect(env(ctx, t, 0.0005, 0.25, 0.02)).connect(dest)
        o.start(t)
        o.stop(t + 0.04)
      }
      break
    }
    case 'subdrop': {
      const o = ctx.createOscillator()
      o.type = 'sine'
      o.frequency.setValueAtTime(110, time)
      o.frequency.exponentialRampToValueAtTime(28, time + 2)
      o.connect(env(ctx, time, 0.01, 0.9, 2.2)).connect(dest)
      o.start(time)
      o.stop(time + 2.4)
      break
    }
  }
}

/** Phản hồi xung (impulse response) tổng hợp cho reverb, dùng được cả khi render offline. */
export function makeImpulse(ctx: BaseAudioContext, seconds = 2.2): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(2, len, ctx.sampleRate)
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch)
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3)
  }
  return buf
}
