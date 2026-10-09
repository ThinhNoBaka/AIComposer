// Bộ nhớ đệm bản thu giọng đã giải mã: phát trực tiếp, render WAV, stems dùng chung một AudioBuffer.

import { api } from '../api/client'
import type { VocalTrack } from '../core/song'

const cache = new Map<string, Promise<AudioBuffer>>()

/** Khoá đệm: bản đã chỉnh đổi mỗi lần chỉnh lại (correctedAt) nên nạp lại bản mới. */
export function vocalKey(v: Pick<VocalTrack, 'takeId' | 'version' | 'correctedAt'>): string {
  return `${v.takeId}|${v.version}|${v.version === 'corrected' ? (v.correctedAt ?? 0) : 0}`
}

/** Giải mã bằng OfflineAudioContext riêng: không cần người dùng bấm trước, buffer dùng được ở mọi context. */
async function decode(data: ArrayBuffer): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(1, 1, 44100)
  return ctx.decodeAudioData(data)
}

export function loadVocalBuffer(v: Pick<VocalTrack, 'takeId' | 'version' | 'correctedAt'>): Promise<AudioBuffer> {
  const key = vocalKey(v)
  let p = cache.get(key)
  if (!p) {
    p = api.vocalAudio(v.takeId, v.version).then(decode)
    // Lỗi (mất mạng, bản thu đã xoá): bỏ khỏi đệm để lần sau thử lại.
    p.catch(() => cache.delete(key))
    cache.set(key, p)
  }
  return p
}

/** Bỏ mọi bản đệm của một bản thu (sau khi xoá bản thu). */
export function forgetVocal(takeId: string) {
  for (const k of [...cache.keys()]) if (k.startsWith(`${takeId}|`)) cache.delete(k)
}
