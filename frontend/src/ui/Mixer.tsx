import { DRUM_KITS, instrumentFamilies, instrumentLabel } from '../core/instruments'
import type { ChordStyle, DrumStyle, Song, Track, TrackId } from '../core/song'
import type { LoadState } from '../audio/voices'

type Props = {
  song: Song
  status: Record<TrackId, LoadState> | null
  onTrack: (id: TrackId, patch: Partial<Track>, coalesce?: string) => void
  onField: (patch: Partial<Song>, coalesce?: string) => void
  onAudition: (id: TrackId) => void
}

const TRACK_LABEL: Record<TrackId, string> = { melody: 'Giai điệu', chords: 'Hợp âm', bass: 'Bass', drums: 'Trống' }

const STATUS_TEXT: Record<LoadState, string> = {
  loading: 'Đang tải…',
  ready: 'Sẵn sàng',
  fallback: 'Synth dự phòng',
}

const CHORD_STYLES: { id: ChordStyle; label: string }[] = [
  { id: 'block', label: 'Ngân dài' },
  { id: 'pulse', label: 'Đánh theo nhịp' },
  { id: 'arpeggio', label: 'Rải từng nốt' },
]

const DRUM_STYLES: { id: DrumStyle; label: string }[] = [
  { id: 'pop', label: 'Pop' },
  { id: 'ballad', label: 'Ballad' },
  { id: 'lofi', label: 'Lo-fi' },
  { id: 'dance', label: 'Nhảy (EDM)' },
  { id: 'epic', label: 'Sử thi' },
  { id: 'none', label: 'Không trống' },
]

function InstrumentSelect({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={`Nhạc cụ cho ${label}`}>
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

export function Mixer({ song, status, onTrack, onField, onAudition }: Props) {
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
              <InstrumentSelect value={t.instrument} label={TRACK_LABEL[id]} onChange={(v) => onTrack(id, { instrument: v })} />
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
          </div>
        )
      })}

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
              <button key={c.id} className={song.chordStyle === c.id ? 'is-on' : ''} onClick={() => onField({ chordStyle: c.id })}>
                {c.label}
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
              onField({ drumStyle, tracks: { ...song.tracks, drums: { ...song.tracks.drums, muted: drumStyle === 'none' } } })
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
        <label className="field">
          <span>Đung đưa (swing): {Math.round(song.swing * 200)}%</span>
          <input type="range" min={0} max={0.5} step={0.05} value={song.swing} onChange={(e) => onField({ swing: Number(e.target.value) }, 'swing')} />
        </label>
      </div>
    </div>
  )
}
