// Timeline kiểu phần mềm làm nhạc: thước ô nhịp, cấu trúc bài, hợp âm, piano roll (có chữ của lời trên nốt)
// và làn hiệu ứng dùng chung một thanh cuộn ngang và một vạch chạy.
// Phía sau bài luôn có thêm vài ô trống: đặt nốt hoặc hiệu ứng vào đó là bài tự dài ra.

import { useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { getFx, type FxDef } from '../audio/fx'
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
}

export function Timeline(p: Props) {
  const { song, stepW, lockScale, grid } = p
  const svgRef = useRef<SVGSVGElement>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
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
    const start = snap(step)
    const note: Note = { id: newId(), pitch, start, dur: Math.min(grid, viewSteps - start), vel: 90 }
    p.onMelody([...song.melody, note], `drag:${note.id}`)
    p.onPreview(pitch)
    svgRef.current?.setPointerCapture(e.pointerId)
    setDrag({ kind: 'resize', id: note.id })
  }

  const onNoteDown = (e: RPointerEvent<SVGRectElement>, n: Note) => {
    e.stopPropagation()
    if (e.button === 2) return
    const rect = (e.target as SVGRectElement).getBoundingClientRect()
    svgRef.current?.setPointerCapture(e.pointerId)
    if (e.clientX > rect.right - 6) setDrag({ kind: 'resize', id: n.id })
    else {
      setDrag({ kind: 'move', id: n.id, offsetStep: pointToCell(e).step - n.start })
      p.onPreview(n.pitch)
    }
  }

  const onMove = (e: RPointerEvent<SVGSVGElement>) => {
    if (!drag) return
    const { step, pitch } = pointToCell(e)
    const n = song.melody.find((x) => x.id === drag.id)
    if (!n) return
    if (drag.kind === 'resize') {
      const end = Math.min(viewSteps, Math.max(n.start + grid, snap(step) + grid))
      if (end - n.start !== n.dur) p.onMelody(song.melody.map((x) => (x.id === n.id ? { ...x, dur: end - n.start } : x)), `drag:${n.id}`)
    } else {
      const start = Math.max(0, Math.min(viewSteps - n.dur, snap(step - drag.offsetStep)))
      if (start !== n.start || pitch !== n.pitch) {
        if (pitch !== n.pitch) p.onPreview(pitch)
        p.onMelody(song.melody.map((x) => (x.id === n.id ? { ...x, start, pitch } : x)), `drag:${n.id}`)
      }
    }
  }

  const removeNote = (id: string) => p.onMelody(song.melody.filter((x) => x.id !== id))

  const seekAt = (e: RPointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const beat = Math.floor((e.clientX - rect.left) / (stepW * 4))
    p.onSeek(Math.max(0, Math.min(song.bars * STEPS_PER_BAR - 4, beat * 4)))
  }

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
            <div className="lane-body" style={{ width }} onPointerDown={seekAt} title="Bấm để chọn chỗ bắt đầu phát">
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
              className="roll"
              onPointerMove={onMove}
              onPointerUp={() => setDrag(null)}
              onPointerCancel={() => setDrag(null)}
              onContextMenu={(e) => e.preventDefault()}
              role="application"
              aria-label="Piano roll: bấm vào lưới để thêm nốt, kéo để di chuyển, kéo mép phải để đổi độ dài, chuột phải hoặc bấm đúp để xoá"
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
              <rect x={0} y={0} width={width} height={height} fill="transparent" onPointerDown={onBackgroundDown} />
              {song.melody.map((n) => {
                const x = n.start * stepW + 1
                const w = Math.max(4, n.dur * stepW - 2)
                const y = rowOf(n.pitch) * ROW_H + 2
                const syl = p.syllables?.get(n.id)
                const cls = `note${isInScale(n.pitch, song.tonic, song.mode) ? '' : ' note-out'}${p.hintIds.has(n.id) ? ' note-hint' : ''}${
                  drag?.kind === 'move' && drag.id === n.id ? ' note-drag' : ''
                }`
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
                      onDoubleClick={() => removeNote(n.id)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        removeNote(n.id)
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
