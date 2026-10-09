import { useEffect, useRef, useState } from 'react'
import { SECTION_LABEL, sectionAt, type Song } from '../core/song'
import { chordOptions } from '../core/suggest'
import { FUNCTION_LABEL, chordFunction, chordName, type Chord } from '../core/theory'

type Props = {
  song: Song
  onSetChord: (bar: number, chord: Chord) => void
  onPreviewChord: (chord: Chord) => void
}

function FitMeter({ fit }: { fit: number }) {
  // fit -1..1 → 0..3 vạch
  const level = fit <= -0.2 ? 0 : fit < 0.3 ? 1 : fit < 0.7 ? 2 : 3
  return (
    <span className="fit" aria-label={`Độ hợp với giai điệu: ${level}/3`} title="Độ hợp với giai điệu">
      {[1, 2, 3].map((i) => (
        <span key={i} className={i <= level ? 'fit-bar on' : 'fit-bar'} />
      ))}
    </span>
  )
}

export function ChordRow({ song, onSetChord, onPreviewChord }: Props) {
  const [open, setOpen] = useState<number | null>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const hasMelody = song.melody.length > 0

  useEffect(() => {
    if (open === null) return
    const close = (e: MouseEvent) => {
      if (rowRef.current && !rowRef.current.contains(e.target as Node)) setOpen(null)
    }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null)
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', esc)
    }
  }, [open])

  return (
    <div className="chord-row" ref={rowRef}>
      {song.chords.map((c, bar) => {
        const fn = chordFunction(c.degree)
        const sec = sectionAt(song, bar)
        return (
          <div key={bar} className="chord-slot">
            <button
              className={`chord-card fn-${fn}${open === bar ? ' active' : ''}`}
              onClick={() => {
                onPreviewChord(c)
                setOpen(open === bar ? null : bar)
              }}
              aria-expanded={open === bar}
              aria-label={`Ô ${bar + 1}: hợp âm ${chordName(c, song.tonic, song.mode)}, ${FUNCTION_LABEL[fn]}. Bấm để nghe và đổi.`}
            >
              <span className="chord-bar">
                Ô {bar + 1}
                {sec?.start === bar && <b className="chord-sec"> · {SECTION_LABEL[sec.kind]}</b>}
              </span>
              <span className="chord-name">{chordName(c, song.tonic, song.mode)}</span>
              <span className="chord-fn">{FUNCTION_LABEL[fn]}</span>
            </button>
            {open === bar && (
              <div className="chord-pop" role="menu">
                <div className="chord-pop-title">Đổi hợp âm ô {bar + 1}</div>
                {chordOptions(song, bar).map((o) => (
                  <button
                    key={o.chord.degree}
                    role="menuitem"
                    className={`chord-opt fn-${o.fn}`}
                    onMouseEnter={() => onPreviewChord(o.chord)}
                    onFocus={() => onPreviewChord(o.chord)}
                    onClick={() => {
                      onSetChord(bar, o.chord)
                      onPreviewChord(o.chord)
                      setOpen(null)
                    }}
                  >
                    <span className="chord-opt-name">{chordName(o.chord, song.tonic, song.mode)}</span>
                    <span className="chord-opt-fn">{o.sameFunction ? 'Cùng cảm giác' : FUNCTION_LABEL[o.fn]}</span>
                    {hasMelody && <FitMeter fit={o.fit} />}
                  </button>
                ))}
                <div className="chord-pop-hint">Rê chuột để nghe thử, bấm để chọn.</div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
