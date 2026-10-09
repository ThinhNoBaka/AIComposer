// Timeline kiểu phần mềm làm nhạc: thước ô nhịp, cấu trúc bài, hợp âm, piano roll (có chữ của lời trên nốt)
// và làn hiệu ứng dùng chung một thanh cuộn ngang và một vạch chạy.
// Phía sau bài luôn có thêm vài ô trống: đặt nốt hoặc hiệu ứng vào đó là bài tự dài ra.

import { useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { getFx, type FxDef } from '../audio/fx'
import { deleteNotes, moveNotes, notesInBox } from '../core/edit'
import { MAX_BARS, SECTION_LABEL, STEPS_PER_BAR, newId, type FxEvent, type Note, type Song } from '../core/song'
import { FUNCTION_LABEL, chordFunction, chordName, chordPcs, isInScale, isNoChord } from '../core/theory'
import { GHOST_BARS, LABEL_W, pitchLabel } from './geometry'

const ROW_H = 22
const LOW = 55 // G3
const HIGH = 84 // C6

const shortFx = (label: string) => label.replace(/\s*\(.*\)\s*$/, '')

type Drag =
  | { kind: 'move'; id: string; offsetStep: number }
  | { kind: 'resize'; id: string }
  | { kind: 'box'; s0: number; p0: number; s1: number; p1: number; add: boolean }

export type LoopRange = { start: number; end: number }

type Props = {
  song: Song
  stepW: number
  lockScale: boolean
  grid: number
  /** Chữ của lời trên từng nốt. */
  syllables: Map<string, string> | null
  /** Nốt có cảnh báo thanh điệu. */
  hintIds: Set<string>
  selectedBar: number | null
  fxSelected: string
  customFx: FxDef[]
  cursor: number
  onSelectBar: (bar: number) => void
  onMelody: (notes: Note[], coalesce?: string) => void
  onFx: (fx: FxEvent[]) => void
  onSeek: (step: number) => void
  onPreview: (pitch: number) => void
  onPreviewFx: (id: string) => void
  gridRef: React.RefObject<HTMLDivElement | null>
  scrollRef: React.RefObject<HTMLDivElement | null>
  /** Nốt đang chọn (Shift+bấm, Shift+kéo khung). */
  selected: Set<string>
  onSelect: (ids: string[]) => void
  /** Khoá giai điệu: chỉ chọn được (để chép), không thêm, dời, xoá. */
  melodyLocked: boolean
  /** Vùng lặp (bước), kéo trên thước ô nhịp để đặt. */
  loop: LoopRange | null
  loopOn: boolean
  onLoop: (loop: LoopRange) => void
}

export function Timeline(p: Props) {
  const { song, stepW, lockScale, grid } = p
  const svgRef = useRef<SVGSVGElement>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [ruler, setRuler] = useState<{ bar0: number; bar1: number; moved: boolean } | null>(null)
  const sel = p.selected
  const viewBars = Math.min(MAX_BARS, song.bars + GHOST_BARS)
  const viewSteps = viewBars * STEPS_PER_BAR
  const barW = STEPS_PER_BAR * stepW
  const width = viewSteps * stepW
  const songW = song.bars * barW

  const rows = useMemo(() => {
    const out: number[] = []
    for (let x = HIGH; x >= LOW; x--) if (!lockScale || isInScale(x, song.tonic, song.mode)) out.push(x)
    return out
  }, [lockScale, song.tonic, song.mode])
  const height = rows.length * ROW_H

  const rowOf = (pitch: number) => {
    const exact = rows.indexOf(pitch)
    if (exact >= 0) return exact
    let best = 0
    rows.forEach((x, i) => {
      if (Math.abs(x - pitch) < Math.abs(rows[best] - pitch)) best = i
    })
    return best
  }

  // Nền piano roll: gộp các ô liền nhau cùng loại (nốt hợp âm / chủ âm / trong thang / ngoài thang) thành một khối.
  const cells = useMemo(() => {
    const tones = song.chords.map((c) => chordPcs(c, song.tonic, song.mode))
    const out: { r: number; from: number; to: number; cls: string }[] = []
    rows.forEach((pitch, r) => {
      const pc = pitch % 12
      const clsAt = (bar: number) => {
        if (bar >= song.bars) return 'cell cell-ghost'
        if (tones[bar].includes(pc)) return 'cell cell-tone'
        if (pc === song.tonic) return 'cell cell-tonic'
        return isInScale(pitch, song.tonic, song.mode) ? 'cell' : 'cell cell-out'
      }
      let from = 0
      let cls = clsAt(0)
      for (let bar = 1; bar <= viewBars; bar++) {
        const c = bar < viewBars ? clsAt(bar) : ''
        if (c !== cls) {
          out.push({ r, from, to: bar, cls })
          from = bar
          cls = c
        }
      }
    })
    return out
  }, [rows, song.chords, song.tonic, song.mode, song.bars, viewBars])

  const pointToCell = (e: RPointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect()
    const step = Math.max(0, Math.min(viewSteps - 1, Math.floor((e.clientX - rect.left) / stepW)))
    const row = Math.max(0, Math.min(rows.length - 1, Math.floor((e.clientY - rect.top) / ROW_H)))
    return { step, pitch: rows[row] }
  }
  const snap = (step: number) => Math.floor(step / grid) * grid

  const onBackgroundDown = (e: RPointerEvent<SVGRectElement>) => {
    if (e.button !== 0) return
    const { step, pitch } = pointToCell(e)
    if (e.shiftKey || p.melodyLocked) {
      // Kéo khung chọn nhiều nốt.
      svgRef.current?.setPointerCapture(e.pointerId)
      setDrag({ kind: 'box', s0: step, p0: pitch, s1: step + 1, p1: pitch, add: e.shiftKey })
      return
    }
    if (sel.size) {
      // Đang chọn nhiều nốt: bấm ra ngoài là bỏ chọn, chưa thêm nốt.
      p.onSelect([])
      return
    }
    const start = snap(step)
    const note: Note = { id: newId(), pitch, start, dur: Math.min(grid, viewSteps - start), vel: 90 }
    p.onMelody([...song.melody, note], `drag:${note.id}`)
    p.onPreview(pitch)
    svgRef.current?.setPointerCapture(e.pointerId)
    setDrag({ kind: 'resize', id: note.id })
  }

  const removeNotes = (n: Note) => {
    if (p.melodyLocked) return
    const ids = sel.has(n.id) ? sel : new Set([n.id])
    p.onMelody(deleteNotes(song.melody, ids))
    p.onSelect([])
  }

  const onNoteDown = (e: RPointerEvent<SVGRectElement>, n: Note) => {
    e.stopPropagation()
    if (e.button === 2) return
    if (e.shiftKey) {
      // Shift+bấm: thêm/bỏ nốt khỏi nhóm đang chọn.
      p.onSelect(sel.has(n.id) ? [...sel].filter((x) => x !== n.id) : [...sel, n.id])
      return
    }
    if (!sel.has(n.id)) p.onSelect([n.id])
    p.onPreview(n.pitch)
    if (p.melodyLocked) return
    const rect = (e.target as SVGRectElement).getBoundingClientRect()
    svgRef.current?.setPointerCapture(e.pointerId)
    if (e.clientX > rect.right - 6) setDrag({ kind: 'resize', id: n.id })
    else {
      setDrag({ kind: 'move', id: n.id, offsetStep: pointToCell(e).step - n.start })
    }
  }

  const onMove = (e: RPointerEvent<SVGSVGElement>) => {
    if (!drag) return
    const { step, pitch } = pointToCell(e)
    if (drag.kind === 'box') {
      if (step + 1 !== drag.s1 || pitch !== drag.p1) setDrag({ ...drag, s1: step + 1, p1: pitch })
      return
    }
    const n = song.melody.find((x) => x.id === drag.id)
    if (!n) return
    if (drag.kind === 'resize') {
      const end = Math.min(viewSteps, Math.max(n.start + grid, snap(step) + grid))
      if (end - n.start !== n.dur) p.onMelody(song.melody.map((x) => (x.id === n.id ? { ...x, dur: end - n.start } : x)), `drag:${n.id}`)
    } else {
      // Dời cả nhóm theo nốt đang kéo. Khoá thang âm thì dời theo hàng (bậc trong thang) cho nốt không lạc thang.
      const ids = sel.has(n.id) ? sel : new Set([n.id])
      const dStep = snap(step - drag.offsetStep) - n.start
      const dRow = rowOf(pitch) - rowOf(n.pitch)
      if (dStep === 0 && dRow === 0) return
      let next = moveNotes(song.melody, ids, dStep, 0, viewSteps)
      if (dRow) {
        const rowsOf = [...ids].map((id) => rowOf(song.melody.find((x) => x.id === id)?.pitch ?? 0))
        const d = Math.max(-Math.min(...rowsOf), Math.min(rows.length - 1 - Math.max(...rowsOf), dRow))
        next = next.map((x) => (ids.has(x.id) ? { ...x, pitch: rows[rowOf(x.pitch) + d] } : x))
        p.onPreview(rows[rowOf(n.pitch) + d])
      }
      p.onMelody(next, `drag:${n.id}`)
    }
  }

  const endDrag = () => {
    if (drag?.kind === 'box') {
      const ids = notesInBox(song.melody, drag.s0, drag.s1, drag.p0, drag.p1)
      p.onSelect(drag.add ? [...new Set([...sel, ...ids])] : ids)
    }
    setDrag(null)
  }

  // Thước: bấm để chọn chỗ phát; kéo qua nhiều ô để đặt vùng lặp.
  const rulerAt = (e: RPointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    return { beat: Math.floor(x / (stepW * 4)), bar: Math.max(0, Math.min(song.bars - 1, Math.floor(x / barW))) }
  }
  const rulerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const { bar } = rulerAt(e)
    setRuler({ bar0: bar, bar1: bar, moved: false })
  }
  const rulerMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (!ruler) return
    const { bar } = rulerAt(e)
    if (bar !== ruler.bar1) setRuler({ ...ruler, bar1: bar, moved: true })
  }
  const rulerUp = (e: RPointerEvent<HTMLDivElement>) => {
    if (!ruler) return
    if (ruler.moved) {
      const a = Math.min(ruler.bar0, ruler.bar1)
      const b = Math.max(ruler.bar0, ruler.bar1) + 1
      p.onLoop({ start: a * STEPS_PER_BAR, end: b * STEPS_PER_BAR })
    } else {
      const { beat } = rulerAt(e)
      p.onSeek(Math.max(0, Math.min(song.bars * STEPS_PER_BAR - 4, beat * 4)))
    }
    setRuler(null)
  }
  const loopShown = ruler?.moved
    ? { start: Math.min(ruler.bar0, ruler.bar1) * STEPS_PER_BAR, end: (Math.max(ruler.bar0, ruler.bar1) + 1) * STEPS_PER_BAR }
    : p.loop
  const loopRect = loopShown ? { left: loopShown.start * stepW, width: (loopShown.end - loopShown.start) * stepW } : null
  const loopCls = `loop-region${p.loopOn || ruler?.moved ? ' is-on' : ''}`

  // Làn hiệu ứng: gộp các hiệu ứng cùng một phách thành một khối.
  const fxGroups = useMemo(() => {
    const m = new Map<number, FxEvent[]>()
    for (const f of song.fx) m.set(f.start, [...(m.get(f.start) ?? []), f])
    return [...m.entries()].sort((a, b) => a[0] - b[0])
  }, [song.fx])
  const fxName = (id: string) => shortFx(getFx(id, p.customFx)?.label ?? 'Âm thanh đã mất')

  const placeFx = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    const rect = e.currentTarget.getBoundingClientRect()
    const beat = Math.floor((e.clientX - rect.left) / (stepW * 4))
    if (beat < 0 || beat >= viewBars * 4) return
    p.onFx([...song.fx, { id: newId('fx'), fx: p.fxSelected, start: beat * 4 }])
    p.onPreviewFx(p.fxSelected)
  }

  // Thước: số ô nhịp, thưa bớt khi thu nhỏ.
  const labelEvery = barW < 70 ? 4 : barW < 120 ? 2 : 1
  const ghost = <div className="tl-ghost" style={{ left: songW, width: width - songW }} aria-hidden />
  const playhead = <div className="playhead" aria-hidden />

  return (
    <div className="tl" ref={p.scrollRef}>
      <div className="tl-grid" ref={p.gridRef} style={{ width: LABEL_W + width, ['--step-w' as string]: `${stepW}px`, ['--label-w' as string]: `${LABEL_W}px` }}>
        <div className="tl-head">
          <div className="lane lane-ruler">
            <div className="lane-label">Ô nhịp</div>
            <div
              className="lane-body"
              style={{ width }}
              onPointerDown={rulerDown}
              onPointerMove={rulerMove}
              onPointerUp={rulerUp}
              onPointerCancel={() => setRuler(null)}
              title="Bấm để chọn chỗ bắt đầu phát, kéo qua nhiều ô để đặt vùng lặp"
            >
              {loopRect && <div className={loopCls} style={loopRect} aria-label="Vùng lặp" />}
              {Array.from({ length: viewBars }, (_, b) => (
                <div key={b} className={`ruler-bar${b >= song.bars ? ' is-ghost' : ''}`} style={{ left: b * barW, width: barW }}>
                  {b % labelEvery === 0 && <span>{b + 1}</span>}
                </div>
              ))}
              <div className="cursor" style={{ left: p.cursor * stepW }} aria-label="Chỗ bắt đầu phát" />
              {playhead}
            </div>
          </div>
          <div className="lane lane-sec">
            <div className="lane-label">Cấu trúc</div>
            <div className="lane-body" style={{ width }}>
              {song.sections?.length ? (
                song.sections.map((x) => (
                  <div key={x.start} className={`sec sec-${x.kind}`} style={{ left: x.start * barW + 1, width: x.bars * barW - 3 }}>
                    {SECTION_LABEL[x.kind]}
                  </div>
                ))
              ) : (
                <div className="sec sec-none" style={{ left: 1, width: songW - 3 }}>
                  Một đoạn, chưa chia dạo đầu, điệp khúc
                </div>
              )}
              <div className="sec sec-ghost" style={{ left: songW + 1, width: width - songW - 3 }}>
                Đặt nốt vào đây để bài dài thêm
              </div>
            </div>
          </div>
          <div className="lane lane-chord">
            <div className="lane-label">Hợp âm</div>
            <div className="lane-body" style={{ width }}>
              {song.chords.map((c, bar) => {
                if (isNoChord(c))
                  return (
                    <button
                      key={bar}
                      className={`chord chord-empty${p.selectedBar === bar ? ' is-on' : ''}`}
                      style={{ left: bar * barW + 1, width: barW - 3 }}
                      onClick={() => p.onSelectBar(bar)}
                      aria-pressed={p.selectedBar === bar}
                      aria-label={`Ô ${bar + 1}: chưa có hợp âm. Bấm để chọn.`}
                    />
                  )
                const fn = chordFunction(c.degree)
                return (
                  <button
                    key={bar}
                    className={`chord fn-${fn}${p.selectedBar === bar ? ' is-on' : ''}`}
                    style={{ left: bar * barW + 1, width: barW - 3 }}
                    onClick={() => p.onSelectBar(bar)}
                    aria-pressed={p.selectedBar === bar}
                    aria-label={`Ô ${bar + 1}: hợp âm ${chordName(c, song.tonic, song.mode)}, ${FUNCTION_LABEL[fn]}. Bấm để đổi.`}
                  >
                    {chordName(c, song.tonic, song.mode)}
                  </button>
                )
              })}
              {ghost}
            </div>
          </div>
        </div>

        <div className="lane lane-roll">
          <div className="lane-label keys" style={{ height }}>
            {rows.map((x) => (
              <div key={x} className={`key${x % 12 === song.tonic ? ' is-tonic' : ''}`} style={{ height: ROW_H }}>
                {pitchLabel(x)}
              </div>
            ))}
          </div>
          <div className="lane-body" style={{ width, height }}>
            <svg
              ref={svgRef}
              width={width}
              height={height}
              className={`roll${p.melodyLocked ? ' is-locked' : ''}`}
              onPointerMove={onMove}
              onPointerUp={endDrag}
              onPointerCancel={() => setDrag(null)}
              onContextMenu={(e) => e.preventDefault()}
              role="application"
              aria-label="Piano roll: bấm vào lưới để thêm nốt, kéo để di chuyển, kéo mép phải để đổi độ dài, chuột phải hoặc bấm đúp để xoá. Giữ Shift để chọn nhiều nốt"
            >
              {cells.map((c) => (
                <rect key={`${c.r}:${c.from}`} x={c.from * barW} y={c.r * ROW_H} width={(c.to - c.from) * barW} height={ROW_H} className={c.cls} />
              ))}
              {rows.map((_, r) => (
                <line key={r} x1={0} x2={width} y1={(r + 1) * ROW_H} y2={(r + 1) * ROW_H} className="roll-hline" />
              ))}
              {Array.from({ length: viewSteps / 4 + 1 }, (_, b) => (
                <line key={b} x1={b * 4 * stepW} x2={b * 4 * stepW} y1={0} y2={height} className={b % 4 === 0 ? 'roll-bar' : 'roll-beat'} />
              ))}
              {loopRect && p.loopOn && <rect x={loopRect.left} y={0} width={loopRect.width} height={height} className="loop-band" />}
              <rect x={0} y={0} width={width} height={height} fill="transparent" onPointerDown={onBackgroundDown} />
              {song.melody.map((n) => {
                const x = n.start * stepW + 1
                const w = Math.max(4, n.dur * stepW - 2)
                const y = rowOf(n.pitch) * ROW_H + 2
                const syl = p.syllables?.get(n.id)
                const cls = `note${isInScale(n.pitch, song.tonic, song.mode) ? '' : ' note-out'}${p.hintIds.has(n.id) ? ' note-hint' : ''}${
                  drag?.kind === 'move' && (drag.id === n.id || sel.has(n.id)) ? ' note-drag' : ''
                }${sel.has(n.id) ? ' is-sel' : ''}`
                return (
                  <g key={n.id}>
                    <rect
                      x={x}
                      y={y}
                      width={w}
                      height={ROW_H - 4}
                      rx={3}
                      className={cls}
                      onPointerDown={(e) => onNoteDown(e, n)}
                      onDoubleClick={() => removeNotes(n)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        removeNotes(n)
                      }}
                    >
                      <title>{`${pitchLabel(n.pitch)}${syl && syl !== '–' ? `, chữ “${syl}”` : ''}. Kéo để di chuyển, kéo mép phải để đổi độ dài, chuột phải để xoá`}</title>
                    </rect>
                    {syl && (
                      <text x={x + 4} y={w >= 22 ? y + ROW_H - 9 : y - 3} className={`syl${w >= 22 ? '' : ' syl-out'}`}>
                        {syl}
                      </text>
                    )}
                  </g>
                )
              })}
              {drag?.kind === 'box' && (
                <rect
                  className="sel-box"
                  x={Math.min(drag.s0, drag.s1) * stepW}
                  y={Math.min(rowOf(drag.p0), rowOf(drag.p1)) * ROW_H}
                  width={Math.abs(drag.s1 - drag.s0) * stepW}
                  height={(Math.abs(rowOf(drag.p0) - rowOf(drag.p1)) + 1) * ROW_H}
                />
              )}
            </svg>
            {playhead}
          </div>
        </div>

        <div className="tl-foot">
          <div className="lane lane-fx">
            <div className="lane-label">Hiệu ứng</div>
            <div className="lane-body" style={{ width }} onPointerDown={placeFx} title="Bấm vào một phách để đặt hiệu ứng đang chọn ở bảng Hiệu ứng">
              {fxGroups.map(([start, list]) => (
                <button
                  key={start}
                  className="fx-block"
                  style={{ left: start * stepW, maxWidth: Math.max(barW, 60) }}
                  onClick={() => p.onFx(song.fx.filter((f) => f.id !== list.at(-1)!.id))}
                  title={`${list.map((f) => fxName(f.fx)).join(', ')}. Bấm để bỏ.`}
                >
                  {list.map((f) => fxName(f.fx)).join(' + ')}
                </button>
              ))}
              {ghost}
              {playhead}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
