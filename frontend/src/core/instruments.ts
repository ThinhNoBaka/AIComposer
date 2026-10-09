import { CUSTOM_SYNTH, DEFAULT_SYNTH, type SynthPreset, type Track } from './song'

// Danh sách 128 nhạc cụ General MIDI theo đúng thứ tự program (0..127),
// đặt tên theo bộ sample midi-js-soundfonts mà smplr dùng.

export const GM_INSTRUMENTS = [
  'acoustic_grand_piano', 'bright_acoustic_piano', 'electric_grand_piano', 'honkytonk_piano',
  'electric_piano_1', 'electric_piano_2', 'harpsichord', 'clavinet',
  'celesta', 'glockenspiel', 'music_box', 'vibraphone', 'marimba', 'xylophone', 'tubular_bells', 'dulcimer',
  'drawbar_organ', 'percussive_organ', 'rock_organ', 'church_organ', 'reed_organ', 'accordion', 'harmonica', 'tango_accordion',
  'acoustic_guitar_nylon', 'acoustic_guitar_steel', 'electric_guitar_jazz', 'electric_guitar_clean',
  'electric_guitar_muted', 'overdriven_guitar', 'distortion_guitar', 'guitar_harmonics',
  'acoustic_bass', 'electric_bass_finger', 'electric_bass_pick', 'fretless_bass',
  'slap_bass_1', 'slap_bass_2', 'synth_bass_1', 'synth_bass_2',
  'violin', 'viola', 'cello', 'contrabass', 'tremolo_strings', 'pizzicato_strings', 'orchestral_harp', 'timpani',
  'string_ensemble_1', 'string_ensemble_2', 'synth_strings_1', 'synth_strings_2',
  'choir_aahs', 'voice_oohs', 'synth_choir', 'orchestra_hit',
  'trumpet', 'trombone', 'tuba', 'muted_trumpet', 'french_horn', 'brass_section', 'synth_brass_1', 'synth_brass_2',
  'soprano_sax', 'alto_sax', 'tenor_sax', 'baritone_sax', 'oboe', 'english_horn', 'bassoon', 'clarinet',
  'piccolo', 'flute', 'recorder', 'pan_flute', 'blown_bottle', 'shakuhachi', 'whistle', 'ocarina',
  'lead_1_square', 'lead_2_sawtooth', 'lead_3_calliope', 'lead_4_chiff',
  'lead_5_charang', 'lead_6_voice', 'lead_7_fifths', 'lead_8_bass__lead',
  'pad_1_new_age', 'pad_2_warm', 'pad_3_polysynth', 'pad_4_choir',
  'pad_5_bowed', 'pad_6_metallic', 'pad_7_halo', 'pad_8_sweep',
  'fx_1_rain', 'fx_2_soundtrack', 'fx_3_crystal', 'fx_4_atmosphere',
  'fx_5_brightness', 'fx_6_goblins', 'fx_7_echoes', 'fx_8_scifi',
  'sitar', 'banjo', 'shamisen', 'koto', 'kalimba', 'bagpipe', 'fiddle', 'shanai',
  'tinkle_bell', 'agogo', 'steel_drums', 'woodblock', 'taiko_drum', 'melodic_tom', 'synth_drum', 'reverse_cymbal',
  'guitar_fret_noise', 'breath_noise', 'seashore', 'bird_tweet', 'telephone_ring', 'helicopter', 'applause', 'gunshot',
] as const

export type GmInstrument = (typeof GM_INSTRUMENTS)[number]

// 16 nhóm, mỗi nhóm 8 program liên tiếp.
export const GM_FAMILIES = [
  'Piano',
  'Gõ có cao độ (chuông, mộc cầm)',
  'Organ, accordion, harmonica',
  'Guitar',
  'Bass',
  'Đàn dây (violin, cello, harp)',
  'Dàn dây và hợp xướng',
  'Kèn đồng',
  'Kèn gỗ và saxophone',
  'Sáo',
  'Synth lead',
  'Synth pad (nền)',
  'Synth hiệu ứng',
  'Nhạc cụ dân tộc thế giới',
  'Bộ gõ',
  'Âm thanh hiệu ứng',
] as const

const VI_NAMES: Partial<Record<GmInstrument, string>> = {
  acoustic_grand_piano: 'Piano cơ',
  bright_acoustic_piano: 'Piano sáng',
  electric_grand_piano: 'Piano điện',
  electric_piano_1: 'Electric piano (Rhodes)',
  electric_piano_2: 'Electric piano (FM)',
  music_box: 'Hộp nhạc',
  vibraphone: 'Vibraphone',
  marimba: 'Marimba',
  xylophone: 'Mộc cầm (xylophone)',
  tubular_bells: 'Chuông ống',
  church_organ: 'Organ nhà thờ',
  accordion: 'Accordion',
  harmonica: 'Kèn harmonica',
  acoustic_guitar_nylon: 'Guitar cổ điển (dây nylon)',
  acoustic_guitar_steel: 'Guitar acoustic (dây sắt)',
  electric_guitar_clean: 'Guitar điện (clean)',
  distortion_guitar: 'Guitar điện (distortion)',
  acoustic_bass: 'Bass acoustic',
  electric_bass_finger: 'Bass điện (ngón)',
  fretless_bass: 'Bass fretless',
  synth_bass_1: 'Synth bass 1',
  violin: 'Violin',
  viola: 'Viola',
  cello: 'Cello',
  contrabass: 'Contrabass',
  orchestral_harp: 'Đàn hạc',
  timpani: 'Trống timpani',
  string_ensemble_1: 'Dàn dây 1',
  string_ensemble_2: 'Dàn dây 2',
  choir_aahs: 'Hợp xướng "aah"',
  voice_oohs: 'Giọng "ooh"',
  trumpet: 'Trumpet',
  trombone: 'Trombone',
  french_horn: 'Kèn French horn',
  brass_section: 'Dàn kèn đồng',
  alto_sax: 'Saxophone alto',
  tenor_sax: 'Saxophone tenor',
  oboe: 'Oboe',
  clarinet: 'Clarinet',
  flute: 'Sáo flute',
  pan_flute: 'Sáo pan',
  shakuhachi: 'Sáo shakuhachi (gần sáo trúc)',
  whistle: 'Huýt sáo',
  ocarina: 'Ocarina',
  pad_2_warm: 'Pad ấm',
  koto: 'Koto (gần đàn tranh)',
  sitar: 'Sitar',
  shamisen: 'Shamisen',
  kalimba: 'Kalimba',
  bagpipe: 'Kèn túi',
  taiko_drum: 'Trống taiko',
  steel_drums: 'Trống thép',
  fx_1_rain: 'Hiệu ứng mưa (synth)',
  guitar_fret_noise: 'Tiếng phím guitar',
  breath_noise: 'Tiếng hơi thở',
  seashore: 'Sóng biển',
  bird_tweet: 'Chim hót',
  telephone_ring: 'Chuông điện thoại',
  helicopter: 'Trực thăng',
  applause: 'Vỗ tay',
  gunshot: 'Tiếng súng',
}

export function instrumentLabel(name: string): string {
  if (name === CUSTOM_SYNTH) return 'Synth tự chỉnh'
  const vi = VI_NAMES[name as GmInstrument]
  if (vi) return vi
  return name
    .replace(/__/g, ' ')
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase())
}

export function gmProgram(name: string): number {
  const i = GM_INSTRUMENTS.indexOf(name as GmInstrument)
  return i < 0 ? 0 : i
}

/**
 * Program GM khi xuất MIDI. Synth tự chỉnh không có trong GM: track bass dùng synth bass,
 * tiếng vào chậm (attack dài) dùng pad, còn lại dùng synth lead gần dạng sóng nhất.
 */
export function trackProgram(track: Pick<Track, 'instrument' | 'synth'>, id: 'melody' | 'chords' | 'bass'): number {
  if (track.instrument !== CUSTOM_SYNTH) return gmProgram(track.instrument)
  const p = track.synth ?? DEFAULT_SYNTH
  if (id === 'bass') return gmProgram(p.wave === 'square' || p.wave === 'sawtooth' ? 'synth_bass_2' : 'synth_bass_1')
  if (p.attack >= 0.15) return gmProgram(p.wave === 'sine' || p.wave === 'triangle' ? 'pad_2_warm' : 'pad_3_polysynth')
  const lead: Record<SynthPreset['wave'], GmInstrument> = { square: 'lead_1_square', sawtooth: 'lead_2_sawtooth', triangle: 'lead_4_chiff', sine: 'lead_3_calliope' }
  return gmProgram(lead[p.wave])
}

export function instrumentFamilies(): { family: string; instruments: GmInstrument[] }[] {
  return GM_FAMILIES.map((family, f) => ({
    family,
    instruments: GM_INSTRUMENTS.slice(f * 8, f * 8 + 8) as GmInstrument[],
  }))
}

export const DRUM_KITS = ['TR-808', 'Casio-RZ1', 'LM-2', 'MFB-512', 'Roland CR-8000'] as const
