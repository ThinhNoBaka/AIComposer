import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api, type VocalCorrectResult, type VocalTakeSummary } from '../api/client'
import { MicRecorder, micErrorMessage, recorderSupported, scheduleCountIn } from '../audio/recorder'
import { forgetVocal, loadVocalBuffer } from '../audio/vocalCache'
import { STEPS_PER_BAR, stepSeconds, vocalOffsetSec, type Song, type VocalRecipe, type VocalTrack, type VocalVersion } from '../core/song'
import { estimateLatencyMs, f0Path, notesToSeconds, pitchRange, takeOffsetMs } from '../core/vocal'

/** Server giữ bản thu tối đa 5 phút; dừng sớm một chút cho chắc. */
const MAX_SECONDS = 290

type Phase = 'idle' | 'opening' | 'countin' | 'recording' | 'uploading' | 'correcting'

type Props = {
  song: Song
  serverOk: boolean | null
  projectId?: string
  /** Vị trí con trỏ phát (bước). */
  cursor: number
  onEnsureAudio: () => Promise<AudioContext>
  /** Phát nhạc nền (không kèm giọng cũ) từ bước `fromStep`, bắt đầu đúng lúc `at` (đồng hồ AudioContext). */
  onPlayBacking: (fromStep: number, at: number) => Promise<void>
  onStopPlayback: () => void
  onSetVocal: (v: VocalTrack | undefined) => void
  onPatchVocal: (patch: Partial<VocalTrack>, coalesce?: string) => void
}

const MODES: { id: VocalRecipe['mode']; label: string }[] = [
  { id: 'melody', label: 'Theo giai điệu' },
  { id: 'scale', label: 'Theo thang âm' },
  { id: 'chromatic', label: 'Mọi nửa cung' },
]

function serverMessage(e: unknown): string {
  if (e instanceof ApiError && e.status === 0) return 'Không kết nối được máy chủ. Nếu đang chạy trên máy, hãy bật backend (xem README).'
  return e instanceof Error ? e.message : String(e)
}

function newVocal(takeId: string, offsetMs: number, prev?: VocalTrack): VocalTrack {
  // Bản thu mới giữ cách trộn của giọng trước (âm lượng, pan, EQ, vang).
  return {
    takeId,
    version: 'original',
    offsetMs,
    volume: prev?.volume ?? 0.9,
    muted: false,
    ...(prev?.pan !== undefined && { pan: prev.pan }),
    ...(prev?.eq !== undefined && { eq: prev.eq }),
    ...(prev?.reverb !== undefined && { reverb: prev.reverb }),
  }
}

const timeText = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/** Đường cao độ trước/sau khi chỉnh, vẽ chồng lên các nốt giai điệu (theo thời gian của bản thu). */
function PitchChart({ f0, song, vocal }: { f0: VocalCorrectResult['f0']; song: Song; vocal: VocalTrack }) {
  const dur = Math.max(f0.original.length, f0.corrected.length) * f0.hop_s
  if (dur <= 0) return null
  const off = vocalOffsetSec(vocal)
  const st = stepSeconds(song.bpm)
  const notes = song.melody
    .map((n) => ({ pitch: n.pitch, t0: n.start * st - off, t1: (n.start + n.dur) * st - off }))
    .filter((n) => n.t1 > 0 && n.t0 < dur)
  const [lo, hi] = pitchRange([f0.original, f0.corrected], notes.map((n) => n.pitch))
  const W = 600
  const H = 150
  const x = (t: number) => (t / dur) * W
  const y = (p: number) => H - ((p - lo) / (hi - lo)) * H
  return (
    <figure className="voc-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Đường cao độ giọng hát trước và sau khi chỉnh">
        {notes.map((n, i) => (
          <rect key={i} className="voc-note" x={x(Math.max(0, n.t0))} y={y(n.pitch + 0.5)} width={Math.max(1, x(Math.min(dur, n.t1)) - x(Math.max(0, n.t0)))} height={H / (hi - lo)} />
        ))}
        <path className="voc-orig" d={f0Path(f0.original, f0.hop_s, x, y)} vectorEffect="non-scaling-stroke" />
        <path className="voc-corr" d={f0Path(f0.corrected, f0.hop_s, x, y)} vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption className="voc-legend">
        <span>
          <i className="sw sw-orig" /> Giọng gốc
        </span>
        <span>
          <i className="sw sw-corr" /> Sau khi chỉnh
        </span>
        <span>
          <i className="sw sw-note" /> Nốt giai điệu
        </span>
      </figcaption>
    </figure>
  )
}

export function VocalPanel({ song, serverOk, projectId, cursor, onEnsureAudio, onPlayBacking, onStopPlayback, onSetVocal, onPatchVocal }: Props) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [countIn, setCountIn] = useState(true)
  const [fromCursor, setFromCursor] = useState(false)
  const [beat, setBeat] = useState(0)
  const [seconds, setSeconds] = useState(0)
  const [level, setLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [takes, setTakes] = useState<VocalTakeSummary[] | null>(null)
  const [strength, setStrength] = useState(0.8)
  const [mode, setMode] = useState<VocalRecipe['mode']>('melody')
  const [speed, setSpeed] = useState(40)
  const [vibrato, setVibrato] = useState(true)
  const [f0, setF0] = useState<{ takeId: string; data: VocalCorrectResult['f0'] } | null>(null)
  const [listening, setListening] = useState<VocalVersion | null>(null)

  const recRef = useRef<MicRecorder | null>(null)
  const timers = useRef<number[]>([])
  const session = useRef<{ fromStep: number; playAt: number; recCall: number; latencyMs: number; bpm: number } | null>(null)
  const abRef = useRef<AudioBufferSourceNode | null>(null)
  const songRef = useRef(song)
  songRef.current = song

  const vocal = song.vocal
  const offline = serverOk === false
  const busy = phase !== 'idle'
  const recording = phase === 'opening' || phase === 'countin' || phase === 'recording'
  const current = takes?.find((t) => t.id === vocal?.takeId)

  const clearTimers = () => {
    timers.current.forEach((t) => clearTimeout(t))
    timers.current = []
  }

  const refresh = useCallback(async () => {
    try {
      setTakes(await api.listVocalTakes(projectId))
    } catch (e) {
      setTakes([])
      if (!(e instanceof ApiError && e.status === 0)) setError(serverMessage(e))
    }
  }, [projectId])

  useEffect(() => {
    if (serverOk) void refresh()
  }, [serverOk, refresh])

  const stopAb = () => {
    try {
      abRef.current?.stop()
    } catch {
      /* đã dừng */
    }
    abRef.current = null
    setListening(null)
  }

  // Rời tab khi đang thu: dừng micro và nhạc nền.
  useEffect(
    () => () => {
      clearTimers()
      if (recRef.current) {
        recRef.current.close()
        recRef.current = null
        onStopPlayback()
      }
      try {
        abRef.current?.stop()
      } catch {
        /* đã dừng */
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  // Đồng hồ và mức âm khi đang thu.
  useEffect(() => {
    if (phase !== 'recording') return
    const started = performance.now()
    let raf = 0
    const loop = () => {
      const s = (performance.now() - started) / 1000
      setSeconds(s)
      setLevel(recRef.current?.level() ?? 0)
      if (s >= MAX_SECONDS) void stopRecording()
      else raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  const startRecording = async () => {
    setError(null)
    setInfo(null)
    stopAb()
    if (!recorderSupported()) {
      setError(window.isSecureContext ? 'Trình duyệt này không hỗ trợ thu âm.' : 'Thu âm cần trang chạy HTTPS (hoặc localhost).')
      return
    }
    setPhase('opening')
    try {
      const ctx = await onEnsureAudio()
      onStopPlayback()
      const rec = new MicRecorder(ctx)
      await rec.open()
      recRef.current = rec
      const s = songRef.current
      const fromStep = fromCursor ? cursor : 0
      const playAt = countIn ? scheduleCountIn(ctx, s.bpm) : ctx.currentTime + 0.15
      // Thu luôn từ lúc đếm nhịp để không mất nốt hát lấy đà; mốc trong bài tính ra sau.
      const recCall = ctx.currentTime
      rec.start()
      session.current = { fromStep, playAt, recCall, latencyMs: estimateLatencyMs(ctx), bpm: s.bpm }
      await onPlayBacking(fromStep, playAt)
      if (countIn) {
        setPhase('countin')
        const beatMs = 60000 / s.bpm
        const untilPlay = (playAt - ctx.currentTime) * 1000
        for (let i = 0; i < 4; i++) timers.current.push(window.setTimeout(() => setBeat(i + 1), untilPlay - (4 - i) * beatMs))
        timers.current.push(
          window.setTimeout(() => {
            setBeat(0)
            setPhase('recording')
          }, untilPlay),
        )
      } else setPhase('recording')
    } catch (e) {
      recRef.current?.close()
      recRef.current = null
      onStopPlayback()
      setError(micErrorMessage(e))
      setPhase('idle')
    }
  }

  const stopRecording = async () => {
    clearTimers()
    const rec = recRef.current
    const ses = session.current
    if (!rec || !ses) return
    onStopPlayback()
    recRef.current = null
    setLevel(0)
    if (phase === 'countin' || phase === 'opening') {
      rec.close()
      setPhase('idle')
      return
    }
    try {
      const { blob, filename } = await rec.stop()
      rec.close()
      if (blob.size < 2000) {
        setError('Bản thu quá ngắn. Hãy hát ít nhất vài giây.')
        setPhase('idle')
        return
      }
      setPhase('uploading')
      const offsetMs = takeOffsetMs({
        playFromSec: ses.fromStep * stepSeconds(ses.bpm),
        playAt: ses.playAt,
        recStartAt: rec.startedAt ?? ses.recCall,
        latencyMs: ses.latencyMs,
      })
      const created = await api.uploadVocal(blob, filename.replace(/^[^.]+/, 'giong-hat'), { offsetMs, bpm: ses.bpm, projectId })
      onSetVocal(newVocal(created.id, created.offset_ms, songRef.current.vocal))
      setF0(null)
      setInfo(`Đã lưu bản thu ${created.duration_s.toFixed(1)} giây (bù trễ ${Math.round(ses.latencyMs)} ms). Bấm Phát để nghe cùng nhạc nền.`)
      await refresh()
    } catch (e) {
      setError(serverMessage(e))
    } finally {
      rec.close()
      setPhase('idle')
    }
  }

  const correct = async () => {
    const v = songRef.current.vocal
    if (!v) return
    setError(null)
    setInfo(null)
    setPhase('correcting')
    try {
      const s = songRef.current
      // Server trừ mốc lúc tải lên; phần bù trễ chỉnh tay cộng thêm vào mốc nốt cho khớp.
      const notes = notesToSeconds(s.melody, s.bpm, (v.nudgeMs ?? 0) / 1000)
      const r = await api.correctVocal(v.takeId, {
        strength,
        mode,
        retune_speed_ms: speed,
        keep_vibrato: vibrato,
        key: { tonic: s.tonic, mode: s.mode },
        ...(mode === 'melody' && notes.length ? { notes } : {}),
      })
      const recipe: VocalRecipe = { strength: r.recipe.strength, mode: r.recipe.mode, retune_speed_ms: r.recipe.retune_speed_ms, keep_vibrato: r.recipe.keep_vibrato }
      onPatchVocal({ version: 'corrected', recipe, correctedAt: Date.now() })
      setF0({ takeId: v.takeId, data: r.f0 })
      setInfo(`Đã chỉnh cao độ trong ${(r.elapsed_ms / 1000).toFixed(1)} giây. Bài đang dùng bản đã chỉnh; bản gốc vẫn được giữ.`)
      await refresh()
    } catch (e) {
      setError(serverMessage(e))
    } finally {
      setPhase('idle')
    }
  }

  const listen = async (version: VocalVersion) => {
    const v = songRef.current.vocal
    if (!v) return
    if (listening === version) {
      stopAb()
      return
    }
    stopAb()
    setError(null)
    try {
      onStopPlayback()
      const ctx = await onEnsureAudio()
      const buf = await loadVocalBuffer({ takeId: v.takeId, version, correctedAt: v.correctedAt })
      const node = ctx.createBufferSource()
      node.buffer = buf
      node.connect(ctx.destination)
      node.onended = () => {
        if (abRef.current === node) {
          abRef.current = null
          setListening(null)
        }
      }
      node.start()
      abRef.current = node
      setListening(version)
    } catch (e) {
      setError(serverMessage(e))
    }
  }

  const pickTake = (t: VocalTakeSummary) => {
    stopAb()
    const v = newVocal(t.id, t.offset_ms, songRef.current.vocal)
    if (t.has_corrected && t.recipe) {
      v.version = 'corrected'
      v.recipe = { strength: t.recipe.strength, mode: t.recipe.mode, retune_speed_ms: t.recipe.retune_speed_ms, keep_vibrato: t.recipe.keep_vibrato }
      v.correctedAt = Date.now()
    }
    onSetVocal(v)
    setF0(null)
  }

  const removeTake = async (t: VocalTakeSummary) => {
    if (!window.confirm('Xoá hẳn bản thu này trên máy chủ? Không hoàn tác được.')) return
    try {
      await api.deleteVocalTake(t.id)
      forgetVocal(t.id)
      if (songRef.current.vocal?.takeId === t.id) {
        stopAb()
        onSetVocal(undefined)
        setF0(null)
      }
      await refresh()
    } catch (e) {
      setError(serverMessage(e))
    }
  }

  if (offline) {
    return (
      <div className="hum">
        <p className="hum-warn">Thu và chỉnh giọng hát cần máy chủ. Chưa kết nối được máy chủ nên tab này tạm chưa dùng được; các phần khác của app vẫn dùng bình thường.</p>
      </div>
    )
  }

  const fromBar = Math.floor(cursor / STEPS_PER_BAR) + 1

  return (
    <div className="voc">
      <section className="side-sec">
        <h3 className="side-h">1. Thu giọng theo nhạc</h3>
        <p className="hint">Máy đếm 4 nhịp rồi phát nhạc nền, bạn hát theo. Nên đeo tai nghe để micro không thu lại nhạc nền.</p>
        <div className="row wrap">
          {!recording ? (
            <button className="btn btn-primary hum-rec" onClick={() => void startRecording()} disabled={busy || serverOk === null}>
              Thu giọng
            </button>
          ) : (
            <button className="btn btn-rec-stop hum-rec" onClick={() => void stopRecording()} disabled={phase === 'opening'}>
              {phase === 'recording' ? 'Dừng thu' : 'Huỷ'}
            </button>
          )}
        </div>
        <div className="seg" role="group" aria-label="Thu từ đâu">
          <button className={!fromCursor ? 'is-on' : ''} onClick={() => setFromCursor(false)} disabled={busy}>
            Từ đầu bài
          </button>
          <button className={fromCursor ? 'is-on' : ''} onClick={() => setFromCursor(true)} disabled={busy || cursor === 0}>
            Từ ô {fromBar}
          </button>
        </div>
        <label className="check">
          <input type="checkbox" checked={countIn} onChange={(e) => setCountIn(e.target.checked)} disabled={busy} />
          Đếm 4 nhịp trước khi phát ({song.bpm} BPM)
        </label>
        {phase === 'countin' && (
          <div className="hum-live" aria-live="polite">
            <span className="hum-count">{beat || '…'}</span> Chuẩn bị, nhạc vào sau tiếng gõ thứ 4
          </div>
        )}
        {phase === 'recording' && (
          <div className="hum-live" aria-live="polite">
            <span className="hum-dot" aria-hidden /> Đang thu {timeText(seconds)}
            <span className="hum-meter" aria-label="Mức âm micro">
              <span style={{ width: `${Math.round(level * 100)}%` }} />
            </span>
            {seconds > 3 && level < 0.03 && <span className="hint">Micro chưa nghe thấy gì, hãy hát to hơn hoặc để micro gần hơn.</span>}
          </div>
        )}
        {phase === 'uploading' && <div className="hum-live">Đang gửi bản thu lên máy chủ…</div>}
      </section>

      {error && <p className="hum-error">{error}</p>}
      {info && <p className="hint voc-info">{info}</p>}

      {vocal && (
        <section className="side-sec">
          <h3 className="side-h">2. Chỉnh cao độ</h3>
          <p className="hint">
            Bản thu {current ? `dài ${current.duration_s.toFixed(1)} giây, ` : ''}bắt đầu ở {timeText(Math.max(0, vocalOffsetSec(vocal)))} của bài. Máy kéo giọng về đúng nốt, bản gốc luôn được giữ.
          </p>
          <label className="field">
            <span>Độ mạnh: {Math.round(strength * 100)}%</span>
            <input type="range" min={0} max={1} step={0.05} value={strength} onChange={(e) => setStrength(Number(e.target.value))} disabled={busy} />
          </label>
          <div className="field">
            <span>Chế độ</span>
            <div className="seg voc-seg" role="group" aria-label="Chế độ chỉnh">
              {MODES.map((m) => (
                <button key={m.id} className={mode === m.id ? 'is-on' : ''} onClick={() => setMode(m.id)} disabled={busy}>
                  {m.label}
                </button>
              ))}
            </div>
            {mode === 'melody' && !song.melody.length && <span className="hint">Bài chưa có giai điệu nên máy sẽ kéo theo thang âm.</span>}
          </div>
          <label className="field">
            <span>
              Tốc độ kéo nốt: {speed} ms ({speed < 15 ? 'kiểu auto-tune rõ' : speed <= 80 ? 'tự nhiên' : 'rất nhẹ'})
            </span>
            <input type="range" min={0} max={300} step={5} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} disabled={busy} />
          </label>
          <label className="check">
            <input type="checkbox" checked={vibrato} onChange={(e) => setVibrato(e.target.checked)} disabled={busy} />
            Giữ rung giọng
          </label>
          <div className="row wrap">
            <button className="btn btn-primary" onClick={() => void correct()} disabled={busy}>
              {phase === 'correcting' ? 'Đang chỉnh…' : 'Chỉnh cao độ'}
            </button>
          </div>
          {f0 && f0.takeId === vocal.takeId && <PitchChart f0={f0.data} song={song} vocal={vocal} />}
          {vocal.recipe && !f0 && (
            <p className="hint">
              Lần chỉnh trước: độ mạnh {Math.round(vocal.recipe.strength * 100)}%, {MODES.find((m) => m.id === vocal.recipe!.mode)?.label.toLowerCase()}, kéo nốt{' '}
              {vocal.recipe.retune_speed_ms} ms{vocal.recipe.keep_vibrato ? ', giữ rung giọng' : ''}.
            </p>
          )}

          <h3 className="side-h">3. So sánh và dùng trong bài</h3>
          <div className="row wrap">
            <button className={`btn btn-sm${listening === 'original' ? ' btn-toggle is-on' : ''}`} onClick={() => void listen('original')} disabled={busy}>
              {listening === 'original' ? 'Dừng nghe' : 'Nghe bản gốc'}
            </button>
            <button
              className={`btn btn-sm${listening === 'corrected' ? ' btn-toggle is-on' : ''}`}
              onClick={() => void listen('corrected')}
              disabled={busy || !(vocal.recipe || current?.has_corrected)}
            >
              {listening === 'corrected' ? 'Dừng nghe' : 'Nghe bản đã chỉnh'}
            </button>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={vocal.version === 'corrected'}
              disabled={busy || !(vocal.recipe || current?.has_corrected)}
              onChange={(e) => onPatchVocal({ version: e.target.checked ? 'corrected' : 'original', correctedAt: vocal.correctedAt ?? Date.now() })}
            />
            Dùng bản đã chỉnh trong bài
          </label>
          <label className="field">
            <span>
              Bù trễ: {vocal.nudgeMs ?? 0} ms {(vocal.nudgeMs ?? 0) > 0 ? '(giọng sớm lên)' : (vocal.nudgeMs ?? 0) < 0 ? '(giọng lùi lại)' : ''}
            </span>
            <input
              type="range"
              min={-300}
              max={300}
              step={5}
              value={vocal.nudgeMs ?? 0}
              onChange={(e) => onPatchVocal({ nudgeMs: Number(e.target.value) }, 'vocal-nudge')}
              onDoubleClick={() => onPatchVocal({ nudgeMs: 0 })}
            />
            <span className="hint">Nghe cả bài thấy giọng chậm hơn nhạc thì kéo sang phải, nhanh hơn thì kéo sang trái.</span>
          </label>
          <div className="row wrap">
            <button className="btn btn-sm btn-quiet" onClick={() => onSetVocal(undefined)} disabled={busy}>
              Bỏ giọng khỏi bài
            </button>
          </div>
        </section>
      )}

      <section className="side-sec">
        <h3 className="side-h">Các bản thu</h3>
        {!projectId && <p className="hint">Bài chưa lưu cloud nên danh sách hiện mọi bản thu của bạn. Lưu cloud để gắn bản thu với bài.</p>}
        {takes === null ? (
          <p className="hint">Đang tải danh sách…</p>
        ) : takes.length === 0 ? (
          <p className="hint">Chưa có bản thu nào.</p>
        ) : (
          <ul className="voc-takes">
            {takes.map((t) => {
              const on = t.id === vocal?.takeId
              return (
                <li key={t.id} className={on ? 'is-on' : ''}>
                  <span className="voc-take-meta">
                    <b>{new Date(t.created_at).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</b>
                    <span>
                      {t.duration_s.toFixed(1)} giây{t.has_corrected ? ', đã chỉnh' : ''}
                    </span>
                  </span>
                  <span className="row">
                    <button className={`btn btn-sm${on ? ' btn-toggle is-on' : ''}`} onClick={() => pickTake(t)} disabled={busy || on}>
                      {on ? 'Đang dùng' : 'Dùng'}
                    </button>
                    <button className="btn btn-sm btn-quiet" onClick={() => void removeTake(t)} disabled={busy}>
                      Xoá
                    </button>
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
