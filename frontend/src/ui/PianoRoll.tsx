import { useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { STEPS_PER_BAR, newId, type Note, type Song } from '../core/song'
import { chordPcs, isInScale } from '../core/theory'

const ROW_H = 22
const STEP_W = 14
const GUTTER = 64
const LOW = 55 // G3
const HIGH = 84 // C6

const SOLFEGE = ['Đô', 'Đô#', 'Rê', 'Rê#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si']

export function pitchLabel(p: number): string {
  return `${SOLFEGE[p % 12]} ${Math.floor(p / 12) - 1}`
}

type Drag =
  | { kind: 'move'; id: string; offsetStep: number; startPitch: number; moved: boolean }
  | { kind: 'resize'; id: string }

type Props = {
  song: Song
  lockScale: boolean
  grid: number
  onChange: (notes: Note[], coalesce?: string) => void
  onPreview: (pitch: number) => void
  playheadRef: React.RefObject<HTMLDivElement | null>
}

export function PianoRoll({ song, lockScale, grid, onChange, onPreview, playheadRef }: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const totalSteps = song.bars * STEPS_PER_BAR

  const rows = useMemo(() => {
    const out: number[] = []
    for (let p = HIGH; p >= LOW; p--) if (!lockScale || isInScale(p, song.tonic, song.mode)) out.push(p)
    return out
  }, [lockScale, song.tonic, song.mode])

  const rowOf = (pitch: number) => {
    const exact = rows.indexOf(pitch)
    if (exact >= 0) return exact
    // Nốt nằm ngoài các hàng (vd. vừa bật khoá thang âm): đặt ở hàng gần nhất.
    let best = 0
    rows.forEach((p, i) => {
      if (Math.abs(p - pitch) < Math.abs(rows[best] - pitch)) best = i
    })
    return best
  }

  const chordTones = useMemo(
    () => song.chords.map((c) => chordPcs(c, song.tonic, song.mode)),
    [song.chords, song.tonic, song.mode],
  )

  const width = GUTTER + totalSteps * STEP_W
  const height = rows.length * ROW_H

  const pointToCell = (e: RPointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left - GUTTER
    const y = e.clientY - rect.top
    const step = Math.max(0, Math.min(totalSteps - 1, Math.floor(x / STEP_W)))
    const row = Math.max(0, Math.min(rows.length - 1, Math.floor(y / ROW_H)))
    return { step, row, pitch: rows[row] }
  }

  const snap = (step: number) => Math.floor(step / grid) * grid

  const onBackgroundDown = (e: RPointerEvent<SVGRectElement>) => {
    if (e.button !== 0) return
    const { step, pitch } = pointToCell(e)
    const start = snap(step)
    const note: Note = { id: newId(), pitch, start, dur: Math.min(grid, totalSteps - start), vel: 90 }
    onChange([...song.melody, note], `drag:${note.id}`)
    onPreview(pitch)
    svgRef.current?.setPointerCapture(e.pointerId)
    setDrag({ kind: 'resize', id: note.id })
  }

  const onNoteDown = (e: RPointerEvent<SVGRectElement>, n: Note) => {
    e.stopPropagation()
    if (e.button === 2) return
    const rect = (e.target as SVGRectElement).getBoundingClientRect()
    const nearRight = e.clientX > rect.right - 6
    svgRef.current?.setPointerCapture(e.pointerId)
    if (nearRight) setDrag({ kind: 'resize', id: n.id })
    else {
      const { step } = pointToCell(e)
      setDrag({ kind: 'move', id: n.id, offsetStep: step - n.start, startPitch: n.pitch, moved: false })
      onPreview(n.pitch)
    }
  }

  const onMove = (e: RPointerEvent<SVGSVGElement>) => {
    if (!drag) return
    const { step, pitch } = pointToCell(e)
    const n = song.melody.find((x) => x.id === drag.id)
    if (!n) return
    if (drag.kind === 'resize') {
      const end = Math.max(n.start + grid, snap(step) + grid)
      const dur = Math.min(end, totalSteps) - n.start
      if (dur !== n.dur) onChange(song.melody.map((x) => (x.id === n.id ? { ...x, dur } : x)), `drag:${n.id}`)
    } else {
      const start = Math.max(0, Math.min(totalSteps - n.dur, snap(step - drag.offsetStep)))
      if (start !== n.start || pitch !== n.pitch) {
        if (pitch !== n.pitch) onPreview(pitch)
        onChange(song.melody.map((x) => (x.id === n.id ? { ...x, start, pitch } : x)), `drag:${n.id}`)
        if (!drag.moved) setDrag({ ...drag, moved: true })
      }
    }
  }

  const endDrag = () => setDrag(null)

  const removeNote = (id: string) => onChange(song.melody.filter((x) => x.id !== id))

  return (
    <div className="roll-scroll">
      <div className="roll-inner" style={{ width, height }}>
        <svg
          ref={svgRef}
          width={width}
          height={height}
          className="roll"
          onPointerMove={onMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onContextMenu={(e) => e.preventDefault()}
          role="application"
          aria-label="Piano roll: bấm vào lưới để thêm nốt, kéo để di chuyển, kéo mép phải để đổi độ dài, chuột phải hoặc bấm đúp để xoá"
        >
          {/* Nền: hàng nốt hợp âm của từng ô được tô sáng ("nốt an toàn"). */}
          {rows.map((p, r) => (
            <g key={p}>
              {song.chords.map((_, bar) => {
                const tone = chordTones[bar].includes(p % 12)
                const tonic = p % 12 === song.tonic
                return (
                  <rect
                    key={bar}
                    x={GUTTER + bar * STEPS_PER_BAR * STEP_W}
                    y={r * ROW_H}
                    width={STEPS_PER_BAR * STEP_W}
                    height={ROW_H}
                    className={tone ? 'cell cell-tone' : tonic ? 'cell cell-tonic' : isInScale(p, song.tonic, song.mode) ? 'cell' : 'cell cell-out'}
                  />
                )
              })}
              <text x={8} y={r * ROW_H + ROW_H * 0.68} className={p % 12 === song.tonic ? 'roll-label roll-label-tonic' : 'roll-label'}>
                {pitchLabel(p)}
              </text>
              <line x1={GUTTER} x2={width} y1={(r + 1) * ROW_H} y2={(r + 1) * ROW_H} className="roll-hline" />
            </g>
          ))}
          {Array.from({ length: totalSteps / 4 + 1 }, (_, b) => (
            <line
              key={b}
              x1={GUTTER + b * 4 * STEP_W}
              x2={GUTTER + b * 4 * STEP_W}
              y1={0}
              y2={height}
              className={b % 4 === 0 ? 'roll-bar' : 'roll-beat'}
            />
          ))}
          <rect x={GUTTER} y={0} width={totalSteps * STEP_W} height={height} fill="transparent" onPointerDown={onBackgroundDown} />
          {song.melody.map((n) => {
            const outOfScale = !isInScale(n.pitch, song.tonic, song.mode)
            return (
              <rect
                key={n.id}
                x={GUTTER + n.start * STEP_W + 1}
                y={rowOf(n.pitch) * ROW_H + 2}
                width={Math.max(4, n.dur * STEP_W - 2)}
                height={ROW_H - 4}
                rx={4}
                className={`note${outOfScale ? ' note-out' : ''}${drag?.kind === 'move' && drag.id === n.id ? ' note-drag' : ''}`}
                onPointerDown={(e) => onNoteDown(e, n)}
                onDoubleClick={() => removeNote(n.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  removeNote(n.id)
                }}
              >
                <title>{`${pitchLabel(n.pitch)} — kéo để di chuyển, kéo mép phải để đổi độ dài, chuột phải để xoá`}</title>
              </rect>
            )
          })}
        </svg>
        <div ref={playheadRef} className="playhead" style={{ left: GUTTER, height }} />
      </div>
    </div>
  )
}

export const ROLL_GEOMETRY = { GUTTER, STEP_W }
