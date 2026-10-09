import { DRUM_KITS, instrumentFamilies, instrumentLabel } from '../core/instruments'
import {
  CUSTOM_SYNTH,
  DEFAULT_SYNTH,
  SECTION_LABEL,
  trackEq,
  trackPan,
  trackReverb,
  type ChordStyle,
  type DrumStyle,
  type MixSettings,
  type SectionKind,
  type Song,
  type SynthPreset,
  type SynthWave,
  type Track,
  type TrackId,
  type VocalTrack,
} from '../core/song'
import type { LoadState } from '../audio/voices'

type Props = {
  song: Song
  status: Record<TrackId, LoadState> | null
  onTrack: (id: TrackId, patch: Partial<Track>, coalesce?: string) => void
  onField: (patch: Partial<Song>, coalesce?: string) => void
  onAudition: (id: TrackId) => void
  onVary: () => void
  onVocal: (patch: Partial<VocalTrack>, coalesce?: string) => void
}

const TRACK_LABEL: Record<TrackId, string> = { melody: 'Giai điệu', chords: 'Hợp âm', bass: 'Bass', drums: 'Trống' }

const STATUS_TEXT: Record<LoadState, string> = {
  loading: 'Đang tải…',
  ready: 'Sẵn sàng',
  fallback: 'Synth dự phòng',
}

const CHORD_STYLE_LABEL: Record<ChordStyle, string> = {
  block: 'Ngân dài',
  pulse: 'Đánh theo nhịp',
  arpeggio: 'Rải từng nốt',
  strum: 'Quạt chả',
}
const CHORD_STYLES: ChordStyle[] = ['block', 'pulse', 'arpeggio', 'strum']

const DRUM_STYLES: { id: DrumStyle; label: string }[] = [
  { id: 'pop', label: 'Pop' },
  { id: 'ballad', label: 'Ballad' },
  { id: 'lofi', label: 'Lo-fi' },
  { id: 'dance', label: 'Nhảy (EDM)' },
  { id: 'epic', label: 'Sử thi' },
  { id: 'none', label: 'Không trống' },
]
const DRUM_LABEL = Object.fromEntries(DRUM_STYLES.map((d) => [d.id, d.label])) as Record<DrumStyle, string>

const WAVES: { id: SynthWave; label: string }[] = [
  { id: 'sine', label: 'Tròn' },
  { id: 'triangle', label: 'Mềm' },
  { id: 'square', label: 'Vuông' },
  { id: 'sawtooth', label: 'Sắc' },
]

function InstrumentSelect({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={`Nhạc cụ cho ${label}`}>
      <optgroup label="Tự tạo">
        <option value={CUSTOM_SYNTH}>{instrumentLabel(CUSTOM_SYNTH)}</option>
      </optgroup>
      {instrumentFamilies().map((f) => (
        <optgroup key={f.family} label={f.family}>
          {f.instruments.map((name) => (
            <option key={name} value={name}>
              {instrumentLabel(name)}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

function Knob(props: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; reset?: number }) {
  return (
    <label className="mix-ctl" onDoubleClick={() => props.reset !== undefined && props.onChange(props.reset)} title={props.reset !== undefined ? 'Bấm đúp để đặt lại' : undefined}>
      <span>{props.label}</span>
      <input type="range" min={props.min} max={props.max} step={props.step} value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} />
    </label>
  )
}

const panText = (p: number) => (Math.abs(p) < 0.02 ? 'giữa' : p < 0 ? `trái ${Math.round(-p * 100)}` : `phải ${Math.round(p * 100)}`)
const dbText = (g: number) => (g === 0 ? '0' : `${g > 0 ? '+' : ''}${g}`)

/** Pan, EQ 3 dải và tiếng vang của một track. */
function MixControls({ m, id, onChange }: { m: MixSettings; id: TrackId | 'vocal'; onChange: (patch: Partial<MixSettings>, key: string) => void }) {
  const pan = trackPan(m)
  const eq = trackEq(m)
  const rev = trackReverb(m, id)
  return (
    <div className="mix-grid">
      <Knob label={`Trái–Phải: ${panText(pan)}`} value={pan} min={-1} max={1} step={0.05} reset={0} onChange={(v) => onChange({ pan: v }, `pan:${id}`)} />
      <Knob label={`Vang: ${Math.round(rev * 100)}%`} value={rev} min={0} max={1} step={0.05} onChange={(v) => onChange({ reverb: v }, `rev:${id}`)} />
      <Knob label={`Trầm ${dbText(eq.low)} dB`} value={eq.low} min={-12} max={12} step={1} reset={0} onChange={(v) => onChange({ eq: { ...eq, low: v } }, `eq:${id}`)} />
      <Knob label={`Trung ${dbText(eq.mid)} dB`} value={eq.mid} min={-12} max={12} step={1} reset={0} onChange={(v) => onChange({ eq: { ...eq, mid: v } }, `eq:${id}`)} />
      <Knob label={`Cao ${dbText(eq.high)} dB`} value={eq.high} min={-12} max={12} step={1} reset={0} onChange={(v) => onChange({ eq: { ...eq, high: v } }, `eq:${id}`)} />
    </div>
  )
}

// Thanh trượt độ sáng theo thang log: 0..1 -> 150..12000 Hz.
const CUT_LO = 150
const CUT_HI = 12000
const cutToPos = (hz: number) => Math.log(hz / CUT_LO) / Math.log(CUT_HI / CUT_LO)
const posToCut = (x: number) => Math.round(CUT_LO * Math.pow(CUT_HI / CUT_LO, x))
const ms = (s: number) => (s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(1)} s`)

function SynthEditor({ preset, onChange }: { preset: SynthPreset; onChange: (p: SynthPreset, key: string) => void }) {
  const set = (patch: Partial<SynthPreset>, key = 'synth') => onChange({ ...preset, ...patch }, key)
  return (
    <div className="synth-ed">
      <div className="seg" role="group" aria-label="Dạng sóng">
        {WAVES.map((w) => (
          <button key={w.id} className={preset.wave === w.id ? 'is-on' : ''} onClick={() => set({ wave: w.id }, '')}>
            {w.label}
          </button>
        ))}
      </div>
      <div className="synth-grid">
        <Knob label={`Độ sáng: ${preset.cutoff} Hz`} value={cutToPos(preset.cutoff)} min={0} max={1} step={0.01} onChange={(v) => set({ cutoff: posToCut(v) })} />
        <Knob label={`Cộng hưởng: ${preset.q.toFixed(1)}`} value={preset.q} min={0.1} max={15} step={0.1} onChange={(v) => set({ q: v })} />
        <Knob label={`Vào tiếng: ${ms(preset.attack)}`} value={preset.attack} min={0} max={2} step={0.01} onChange={(v) => set({ attack: v })} />
        <Knob label={`Tắt dần: ${ms(preset.decay)}`} value={preset.decay} min={0.01} max={2} step={0.01} onChange={(v) => set({ decay: v })} />
        <Knob label={`Giữ: ${Math.round(preset.sustain * 100)}%`} value={preset.sustain} min={0} max={1} step={0.05} onChange={(v) => set({ sustain: v })} />
        <Knob label={`Ngân sau: ${ms(preset.release)}`} value={preset.release} min={0.01} max={4} step={0.01} onChange={(v) => set({ release: v })} />
      </div>
    </div>
  )
}

/** Tóm tắt cách đệm từng loại đoạn sau khi biến tấu. */
function VariationSummary({ song }: { song: Song }) {
  const st = song.sectionStyles
  if (!st || !song.sections) return null
  const seen = new Map<SectionKind, string>()
  for (const x of song.sections) {
    const s = st[x.start]
    if (s && !seen.has(x.kind)) seen.set(x.kind, `${CHORD_STYLE_LABEL[s.chordStyle]}, ${DRUM_LABEL[s.drumStyle]}`)
  }
  return (
    <ul className="vary-list">
      {[...seen].map(([kind, text]) => (
        <li key={kind}>
          <b>{SECTION_LABEL[kind]}</b> {text}
        </li>
      ))}
    </ul>
  )
}

export function Mixer({ song, status, onTrack, onField, onAudition, onVary, onVocal }: Props) {
  const vocal = song.vocal
  return (
    <div className="mixer">
      {(['melody', 'chords', 'bass', 'drums'] as TrackId[]).map((id) => {
        const t = song.tracks[id]
        const st = status?.[id]
        return (
          <div key={id} className={`track${t.muted ? ' muted' : ''}`}>
            <div className="track-head">
              <span className="track-name">{TRACK_LABEL[id]}</span>
              {st && <span className={`badge badge-${st}`}>{STATUS_TEXT[st]}</span>}
            </div>
            {id === 'drums' ? (
              <select value={t.instrument} onChange={(e) => onTrack(id, { instrument: e.target.value })} aria-label="Bộ trống">
                {DRUM_KITS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            ) : (
              <InstrumentSelect
                value={t.instrument}
                label={TRACK_LABEL[id]}
                onChange={(v) => onTrack(id, v === CUSTOM_SYNTH ? { instrument: v, synth: t.synth ?? DEFAULT_SYNTH } : { instrument: v })}
              />
            )}
            {t.instrument === CUSTOM_SYNTH && id !== 'drums' && (
              <SynthEditor preset={t.synth ?? DEFAULT_SYNTH} onChange={(p, key) => onTrack(id, { synth: p }, key ? `synth:${id}` : undefined)} />
            )}
            <div className="track-controls">
              <label className="vol">
                <span>Âm lượng</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={t.volume}
                  onChange={(e) => onTrack(id, { volume: Number(e.target.value) }, `vol:${id}`)}
                />
              </label>
              <button className={`btn btn-sm btn-toggle${t.muted ? ' is-on' : ''}`} onClick={() => onTrack(id, { muted: !t.muted })} aria-pressed={t.muted}>
                {t.muted ? 'Đang tắt' : 'Tắt tiếng'}
              </button>
              <button className="btn btn-sm btn-quiet" onClick={() => onAudition(id)}>
                Nghe thử
              </button>
            </div>
            <MixControls m={t} id={id} onChange={(patch, key) => onTrack(id, patch, key)} />
          </div>
        )
      })}

      {vocal && (
        <div className={`track${vocal.muted ? ' muted' : ''}`}>
          <div className="track-head">
            <span className="track-name">Giọng hát</span>
            <span className="badge badge-ready">{vocal.version === 'corrected' ? 'Bản đã chỉnh' : 'Bản gốc'}</span>
          </div>
          <div className="track-controls">
            <label className="vol">
              <span>Âm lượng</span>
              <input type="range" min={0} max={1} step={0.01} value={vocal.volume} onChange={(e) => onVocal({ volume: Number(e.target.value) }, 'vol:vocal')} />
            </label>
            <button className={`btn btn-sm btn-toggle${vocal.muted ? ' is-on' : ''}`} onClick={() => onVocal({ muted: !vocal.muted })} aria-pressed={vocal.muted}>
              {vocal.muted ? 'Đang tắt' : 'Tắt tiếng'}
            </button>
          </div>
          <MixControls m={vocal} id="vocal" onChange={(patch, key) => onVocal(patch, key)} />
        </div>
      )}

      <div className="track settings">
        <div className="track-head">
          <span className="track-name">Cách đệm</span>
        </div>
        <label className="field">
          <span>Tempo: {song.bpm} BPM ({song.bpm < 80 ? 'chậm' : song.bpm < 110 ? 'vừa' : 'nhanh'})</span>
          <input type="range" min={50} max={180} value={song.bpm} onChange={(e) => onField({ bpm: Number(e.target.value) }, 'bpm')} />
        </label>
        <div className="field">
          <span>Hợp âm</span>
          <div className="seg">
            {CHORD_STYLES.map((c) => (
              <button key={c} className={!song.sectionStyles && song.chordStyle === c ? 'is-on' : ''} onClick={() => onField({ chordStyle: c, sectionStyles: undefined })}>
                {CHORD_STYLE_LABEL[c]}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span>Nhịp trống</span>
          <select
            value={song.drumStyle}
            onChange={(e) => {
              const drumStyle = e.target.value as DrumStyle
              onField({ drumStyle, sectionStyles: undefined, tracks: { ...song.tracks, drums: { ...song.tracks.drums, muted: drumStyle === 'none' } } })
            }}
          >
            {DRUM_STYLES.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <span>Độ dày</span>
          <div className="seg">
            {(['Thưa', 'Vừa', 'Dày'] as const).map((label, i) => (
              <button key={label} className={song.density === i ? 'is-on' : ''} onClick={() => onField({ density: i as 0 | 1 | 2 })}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span>Tiếng trống</span>
          <div className="seg">
            <button
              className={song.drumFeel !== 'basic' ? 'is-on' : ''}
              onClick={() => onField({ drumFeel: 'groove' })}
              title="Mẫu trống, chỗ nhấn và độ lệch nhịp học từ tay trống thật (Groove MIDI). Kiểu Hào hùng vẫn dùng mẫu viết tay"
            >
              Tay trống thật
            </button>
            <button className={song.drumFeel === 'basic' ? 'is-on' : ''} onClick={() => onField({ drumFeel: 'basic' })} title="Mẫu cố định, đều như máy">
              Đều như máy
            </button>
          </div>
        </div>
        <label className="field">
          <span>Đung đưa (swing): {Math.round(song.swing * 200)}%</span>
          <input type="range" min={0} max={0.5} step={0.05} value={song.swing} onChange={(e) => onField({ swing: Number(e.target.value) }, 'swing')} />
        </label>
        <div className="field">
          <span>Biến tấu</span>
          <p className="hint">
            {song.sections
              ? 'Mỗi đoạn một cách đệm: đoạn chính thưa, điệp khúc dày hơn, và đổi vài hợp âm điệp khúc sang hợp âm cùng chức năng. Bấm lại để nghe phương án khác.'
              : 'Đổi cách đệm hợp âm và nhịp trống cho cả bài. Hoàn thiện thành bài trước để mỗi đoạn được phối riêng.'}
          </p>
          <VariationSummary song={song} />
          <div className="row wrap">
            <button className="btn btn-sm" onClick={onVary}>
              Biến tấu bản phối
            </button>
            {song.sectionStyles && (
              <button className="btn btn-sm btn-quiet" onClick={() => onField({ sectionStyles: undefined })}>
                Dùng một cách đệm cho cả bài
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
