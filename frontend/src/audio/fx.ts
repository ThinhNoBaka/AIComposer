import type { SynthFxId } from './synth'

export type FxSource =
  | { type: 'gm'; instrument: string; note: number; dur: number }
  | { type: 'synth'; id: SynthFxId }
  | { type: 'custom' }

export type FxDef = { id: string; label: string; group: string; source: FxSource }

export const FX_GROUPS = ['Chuyển cảnh', 'Thiên nhiên', 'Đời sống', 'Không khí'] as const

export const FX_LIBRARY: FxDef[] = [
  { id: 'riser', label: 'Riser (dồn lên)', group: 'Chuyển cảnh', source: { type: 'synth', id: 'riser' } },
  { id: 'downlifter', label: 'Downlifter (hạ xuống)', group: 'Chuyển cảnh', source: { type: 'synth', id: 'downlifter' } },
  { id: 'impact', label: 'Boom (va chạm)', group: 'Chuyển cảnh', source: { type: 'synth', id: 'impact' } },
  { id: 'whoosh', label: 'Whoosh (vút qua)', group: 'Chuyển cảnh', source: { type: 'synth', id: 'whoosh' } },
  { id: 'subdrop', label: 'Sub drop (trầm rơi)', group: 'Chuyển cảnh', source: { type: 'synth', id: 'subdrop' } },
  { id: 'reverse_cymbal', label: 'Cymbal ngược', group: 'Chuyển cảnh', source: { type: 'gm', instrument: 'reverse_cymbal', note: 60, dur: 2 } },
  { id: 'orchestra_hit', label: 'Đánh dàn nhạc', group: 'Chuyển cảnh', source: { type: 'gm', instrument: 'orchestra_hit', note: 60, dur: 1 } },
  { id: 'rain', label: 'Mưa rơi', group: 'Thiên nhiên', source: { type: 'synth', id: 'rain' } },
  { id: 'wind', label: 'Gió thổi', group: 'Thiên nhiên', source: { type: 'synth', id: 'wind' } },
  { id: 'seashore', label: 'Sóng biển', group: 'Thiên nhiên', source: { type: 'gm', instrument: 'seashore', note: 60, dur: 5 } },
  { id: 'bird_tweet', label: 'Chim hót', group: 'Thiên nhiên', source: { type: 'gm', instrument: 'bird_tweet', note: 72, dur: 2 } },
  { id: 'applause', label: 'Vỗ tay', group: 'Đời sống', source: { type: 'gm', instrument: 'applause', note: 60, dur: 4 } },
  { id: 'telephone_ring', label: 'Chuông điện thoại', group: 'Đời sống', source: { type: 'gm', instrument: 'telephone_ring', note: 72, dur: 2 } },
  { id: 'helicopter', label: 'Trực thăng', group: 'Đời sống', source: { type: 'gm', instrument: 'helicopter', note: 60, dur: 4 } },
  { id: 'gunshot', label: 'Tiếng súng', group: 'Đời sống', source: { type: 'gm', instrument: 'gunshot', note: 60, dur: 1 } },
  { id: 'heartbeat', label: 'Tim đập', group: 'Đời sống', source: { type: 'synth', id: 'heartbeat' } },
  { id: 'clock', label: 'Đồng hồ tích tắc', group: 'Đời sống', source: { type: 'synth', id: 'clock' } },
  { id: 'breath_noise', label: 'Hơi thở', group: 'Đời sống', source: { type: 'gm', instrument: 'breath_noise', note: 60, dur: 1.5 } },
  { id: 'vinyl', label: 'Đĩa than rè', group: 'Không khí', source: { type: 'synth', id: 'vinyl' } },
  { id: 'fx_4_atmosphere', label: 'Không gian (synth)', group: 'Không khí', source: { type: 'gm', instrument: 'fx_4_atmosphere', note: 60, dur: 4 } },
  { id: 'fx_3_crystal', label: 'Pha lê (synth)', group: 'Không khí', source: { type: 'gm', instrument: 'fx_3_crystal', note: 72, dur: 3 } },
  { id: 'guitar_fret_noise', label: 'Tiếng phím guitar', group: 'Không khí', source: { type: 'gm', instrument: 'guitar_fret_noise', note: 60, dur: 1 } },
]

export function getFx(id: string, custom: FxDef[] = []): FxDef | undefined {
  return FX_LIBRARY.find((f) => f.id === id) ?? custom.find((f) => f.id === id)
}
