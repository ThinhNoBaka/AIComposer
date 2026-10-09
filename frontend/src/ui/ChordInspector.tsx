import { SECTION_LABEL, sectionAt, type Song } from '../core/song'
import { chordOptions } from '../core/suggest'
import { FUNCTION_LABEL, NO_CHORD, chordFunction, chordName, isNoChord, type Chord } from '../core/theory'

type Props = {
  song: Song
  bar: number | null
  onSetChord: (bar: number, chord: Chord) => void
  onPreviewChord: (chord: Chord) => void
  onNextProgression: () => void
  onHarmonize: () => void
  onToggleSevenths: () => void
  onClose: () => void
  /** Khoá hợp âm: chỉ xem, không đổi. */
  locked: boolean
}

function FitMeter({ fit }: { fit: number }) {
  // fit -1..1 → 0..3 vạch
  const level = fit <= -0.2 ? 0 : fit < 0.3 ? 1 : fit < 0.7 ? 2 : 3
  return (
    <span className="fit" aria-label={`Độ hợp với giai điệu: ${level}/3`} title="Độ hợp với giai điệu">
      {[1, 2, 3].map((i) => (
        <span key={i} className={i <= level ? 'fit-bar is-on' : 'fit-bar'} />
      ))}
    </span>
  )
}

/** Bảng dưới timeline: đổi hợp âm của ô đang chọn, và các thao tác cho cả vòng hợp âm. */
export function ChordInspector({ song, bar, onSetChord, onPreviewChord, onNextProgression, onHarmonize, onToggleSevenths, onClose, locked }: Props) {
  const sevenths = !!song.chords.find((c) => !isNoChord(c))?.seventh
  const chord = bar !== null ? song.chords[bar] : undefined
  const empty = isNoChord(chord)
  const sec = bar !== null ? sectionAt(song, bar) : undefined
  return (
    <fieldset className="inspector" disabled={locked} title={locked ? 'Hợp âm đang khoá. Bỏ Khoá hợp âm để đổi.' : undefined}>
      <div className="insp-main">
        {chord && bar !== null ? (
          <>
            <div className="insp-title">
              <span>
                Ô {bar + 1}
                {sec && ` · ${SECTION_LABEL[sec.kind]}`}
              </span>
              {empty ? (
                <b>Chưa có hợp âm</b>
              ) : (
                <>
                  <b>{chordName(chord, song.tonic, song.mode)}</b>
                  <span className={`tag fn-${chordFunction(chord.degree)}`}>{FUNCTION_LABEL[chordFunction(chord.degree)]}</span>
                </>
              )}
              {!empty && (
                <button className="btn btn-quiet btn-sm insp-clear" onClick={() => onSetChord(bar, { ...NO_CHORD })}>
                  Để trống ô này
                </button>
              )}
              <button className="btn btn-quiet btn-sm" onClick={onClose}>
                Đóng
              </button>
            </div>
            <div className="insp-opts" role="group" aria-label={`Đổi hợp âm ô ${bar + 1}`}>
              {chordOptions(song, bar).map((o) => (
                <button
                  key={o.chord.degree}
                  className={`chord-opt fn-${o.fn}${o.chord.degree === chord.degree ? ' is-on' : ''}`}
                  onMouseEnter={() => onPreviewChord(o.chord)}
                  onFocus={() => onPreviewChord(o.chord)}
                  onClick={() => {
                    onSetChord(bar, o.chord)
                    onPreviewChord(o.chord)
                  }}
                >
                  <span className="chord-opt-name">{chordName(o.chord, song.tonic, song.mode)}</span>
                  <span className="chord-opt-fn">{o.sameFunction ? 'Cùng cảm giác' : FUNCTION_LABEL[o.fn]}</span>
                  {song.melody.length > 0 && <FitMeter fit={o.fit} />}
                </button>
              ))}
            </div>
          </>
        ) : (
          <p className="insp-empty">
            Bấm một hợp âm trên timeline để nghe và đổi. Màu cho biết cảm giác: <span className="tag fn-home">Ổn định</span>{' '}
            <span className="tag fn-move">Chuyển động</span> <span className="tag fn-tension">Căng, muốn về</span>
          </p>
        )}
      </div>
      <div className="insp-actions">
        <button className="btn" onClick={onNextProgression}>
          Đổi vòng hợp âm
        </button>
        <button className="btn" onClick={onHarmonize} disabled={!song.melody.length} title={song.melody.length ? '' : 'Cần có giai điệu trước'}>
          Hợp âm theo giai điệu
        </button>
        <button className={`btn btn-toggle${sevenths ? ' is-on' : ''}`} onClick={onToggleSevenths} aria-pressed={sevenths}>
          Hợp âm màu (7)
        </button>
      </div>
    </fieldset>
  )
}
