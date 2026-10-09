import { useState } from 'react'
import { FX_GROUPS, FX_LIBRARY, getFx, type FxDef } from '../audio/fx'
import { STEPS_PER_BAR, type FxEvent, type Song } from '../core/song'

type Props = {
  song: Song
  customFx: FxDef[]
  selected: string
  onSelect: (id: string) => void
  onPreview: (id: string) => void
  onChange: (fx: FxEvent[]) => void
  onVolume: (v: number) => void
  onUpload: (file: File) => Promise<string | null>
}

/** Thư viện hiệu ứng: chọn một âm thanh ở đây rồi bấm vào làn Hiệu ứng trên timeline để đặt. */
export function FxPanel({ song, customFx, selected, onSelect, onPreview, onChange, onVolume, onUpload }: Props) {
  const [uploadMsg, setUploadMsg] = useState<string | null>(null)
  const all = [...FX_LIBRARY, ...customFx]
  const groups = [...FX_GROUPS, ...(customFx.length ? ['Của bạn'] : [])]

  return (
    <div className="fx">
      <p className="hint">
        Chọn một âm thanh (bấm là nghe thử), rồi bấm vào làn <b>Hiệu ứng</b> dưới cùng timeline ở phách muốn đặt. Đang chọn:{' '}
        <b>{getFx(selected, customFx)?.label ?? selected}</b>.
      </p>
      {groups.map((g) => (
        <div key={g} className="fx-group">
          <h3 className="side-h">{g}</h3>
          <div className="fx-buttons">
            {all
              .filter((f) => f.group === g)
              .map((f) => (
                <button
                  key={f.id}
                  className={`chip${selected === f.id ? ' is-on' : ''}`}
                  onClick={() => {
                    onSelect(f.id)
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
        <span>Thêm âm thanh của bạn (WAV, MP3, OGG)</span>
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
              onSelect(id)
              setUploadMsg(`Đã thêm "${file.name}". Âm thanh tải lên chỉ giữ đến khi tải lại trang.`)
            } else {
              setUploadMsg('Không đọc được file này. Thử file WAV hoặc MP3 khác.')
            }
          }}
        />
      </label>
      {uploadMsg && <p className="hint">{uploadMsg}</p>}
      <label className="field">
        <span>Âm lượng hiệu ứng</span>
        <input type="range" min={0} max={1} step={0.01} value={song.fxVolume} onChange={(e) => onVolume(Number(e.target.value))} />
      </label>
      {song.fx.length > 0 && (
        <>
          <h3 className="side-h">Đã đặt trong bài</h3>
          <ul className="fx-list">
            {[...song.fx]
              .sort((a, b) => a.start - b.start)
              .map((f) => (
                <li key={f.id}>
                  <span>
                    Ô {Math.floor(f.start / STEPS_PER_BAR) + 1}, phách {Math.floor((f.start % STEPS_PER_BAR) / 4) + 1}: {getFx(f.fx, customFx)?.label ?? 'âm thanh đã mất'}
                  </span>
                  <button className="btn btn-quiet btn-sm" onClick={() => onChange(song.fx.filter((x) => x.id !== f.id))}>
                    Bỏ
                  </button>
                </li>
              ))}
          </ul>
        </>
      )}
    </div>
  )
}
