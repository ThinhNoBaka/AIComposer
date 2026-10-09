import { useState } from 'react'
import { FX_GROUPS, FX_LIBRARY, getFx, type FxDef } from '../audio/fx'
import { STEPS_PER_BAR, newId, type FxEvent, type Song } from '../core/song'

type Props = {
  song: Song
  customFx: FxDef[]
  onPreview: (id: string) => void
  onChange: (fx: FxEvent[]) => void
  onVolume: (v: number) => void
  onUpload: (file: File) => Promise<string | null>
}

export function FxPanel({ song, customFx, onPreview, onChange, onVolume, onUpload }: Props) {
  const [selected, setSelected] = useState<string>('riser')
  const [uploadMsg, setUploadMsg] = useState<string | null>(null)
  const beats = song.bars * 4
  const all = [...FX_LIBRARY, ...customFx]
  const groups = [...FX_GROUPS, ...(customFx.length ? ['Của bạn'] : [])]

  const place = (beat: number) => {
    const start = beat * 4
    const existing = song.fx.find((f) => f.start === start && f.fx === selected)
    if (existing) onChange(song.fx.filter((f) => f.id !== existing.id))
    else {
      onChange([...song.fx, { id: newId('fx'), fx: selected, start }])
      onPreview(selected)
    }
  }

  return (
    <div className="fx">
      <div className="fx-palette">
        {groups.map((g) => (
          <div key={g} className="fx-group">
            <div className="fx-group-name">{g}</div>
            <div className="fx-buttons">
              {all
                .filter((f) => f.group === g)
                .map((f) => (
                  <button
                    key={f.id}
                    className={selected === f.id ? 'fx-btn on' : 'fx-btn'}
                    onClick={() => {
                      setSelected(f.id)
                      onPreview(f.id)
                    }}
                    aria-pressed={selected === f.id}
                  >
                    {f.label}
                  </button>
                ))}
            </div>
          </div>
        ))}
        <label className="upload">
          <span>+ Thêm âm thanh của bạn (WAV, MP3, OGG)</span>
          <input
            type="file"
            accept="audio/*"
            onChange={async (e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (!file) return
              setUploadMsg('Đang đọc file…')
              const id = await onUpload(file)
              if (id) {
                setSelected(id)
                setUploadMsg(`Đã thêm "${file.name}". Âm thanh tải lên chỉ giữ đến khi tải lại trang.`)
              } else {
                setUploadMsg('Không đọc được file này. Thử file WAV hoặc MP3 khác.')
              }
            }}
          />
        </label>
        {uploadMsg && <div className="hint">{uploadMsg}</div>}
      </div>

      <div className="fx-lane-wrap">
        <div className="fx-lane-title">
          Bấm vào một phách để đặt <b>{getFx(selected, customFx)?.label ?? selected}</b>, bấm lại để bỏ.
        </div>
        <div className="fx-lane" style={{ gridTemplateColumns: `repeat(${beats}, minmax(22px, 1fr))` }}>
          {Array.from({ length: beats }, (_, beat) => {
            const here = song.fx.filter((f) => f.start === beat * 4)
            return (
              <button
                key={beat}
                className={`fx-cell${beat % 4 === 0 ? ' bar-start' : ''}${here.length ? ' has' : ''}`}
                onClick={() => place(beat)}
                title={here.length ? here.map((f) => getFx(f.fx, customFx)?.label ?? 'Âm thanh không còn (đã tải lại trang)').join(', ') : `Ô ${Math.floor(beat / 4) + 1}, phách ${(beat % 4) + 1}`}
                aria-label={`Ô ${Math.floor(beat / 4) + 1} phách ${(beat % 4) + 1}${here.length ? `: ${here.length} hiệu ứng` : ''}`}
              >
                {beat % 4 === 0 && <span className="fx-bar-no">{beat / 4 + 1}</span>}
                {here.length > 0 && <span className="fx-dot">{here.length}</span>}
              </button>
            )
          })}
        </div>
        {song.fx.length > 0 && (
          <div className="fx-list">
            {[...song.fx]
              .sort((a, b) => a.start - b.start)
              .map((f) => (
                <span key={f.id} className="chip">
                  Ô {Math.floor(f.start / STEPS_PER_BAR) + 1}.{Math.floor((f.start % STEPS_PER_BAR) / 4) + 1}: {getFx(f.fx, customFx)?.label ?? 'âm thanh đã mất'}
                  <button aria-label="Bỏ hiệu ứng này" onClick={() => onChange(song.fx.filter((x) => x.id !== f.id))}>
                    ×
                  </button>
                </span>
              ))}
          </div>
        )}
        <label className="field inline">
          <span>Âm lượng hiệu ứng</span>
          <input type="range" min={0} max={1} step={0.01} value={song.fxVolume} onChange={(e) => onVolume(Number(e.target.value))} />
        </label>
      </div>
    </div>
  )
}
