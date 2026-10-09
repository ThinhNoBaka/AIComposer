import { useEffect, useRef, useState } from 'react'
import { ApiError, api, type HummingJob, type HummingLimits, type HummingResult } from '../api/client'
import { MicRecorder, micErrorMessage, recorderSupported, scheduleCountIn } from '../audio/recorder'
import type { ApplyOptions } from '../core/humming'
import { MAX_BARS, type Song } from '../core/song'
import { NOTE_NAMES } from '../core/theory'

/** Dùng khi chưa hỏi được máy chủ; máy chủ báo giới hạn thật qua /api/humming/limits. */
const DEFAULT_LIMITS: HummingLimits = { max_minutes: 15, max_upload_mb: 200 }

/** 75 giây thành "1:15". */
function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Phase = 'idle' | 'opening' | 'countin' | 'recording' | 'working'
type Take = { blob: Blob; filename: string; url: string; fixedBpm: boolean }

type Props = {
  song: Song
  serverOk: boolean | null
  projectId?: string
  /** Bài đã có giai điệu và còn chỗ: cho ghép đoạn ngân mới nối tiếp. */
  canAppend: boolean
  /** Khoá giai điệu: chỉ được ghép tiếp, không thay giai điệu đang có. */
  melodyLocked?: boolean
  /** Khoá hợp âm: không tự chọn lại hợp âm. */
  chordsLocked?: boolean
  onApply: (result: HummingResult, opts: ApplyOptions) => void
  onAppend: (result: HummingResult, opts: { autoHarmony: boolean }) => void
}

const MODE_VI: Record<string, string> = { major: 'trưởng', minor: 'thứ' }

function serverMessage(e: unknown): string {
  if (e instanceof ApiError && e.status === 0)
    return 'Chưa kết nối được máy chủ nhận nốt. Nếu đang chạy trên máy, hãy bật backend (xem README).'
  return e instanceof Error ? e.message : String(e)
}

/** Vẽ nốt thô máy nghe được (trước khi làm tròn nhịp), để người dùng thấy máy “nghe” ra sao. */
function RawNotes({ result }: { result: HummingResult }) {
  const notes = result.raw_notes
  if (!notes.length) return null
  const t1 = Math.max(...notes.map((n) => n.offset))
  const lo = Math.floor(Math.min(...notes.map((n) => n.pitch))) - 2
  const hi = Math.ceil(Math.max(...notes.map((n) => n.pitch))) + 2
  const W = 600
  const H = 90
  const x = (t: number) => (t / t1) * W
  const y = (p: number) => H - ((p - lo) / (hi - lo)) * H
  return (
    <svg className="hum-raw" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Các nốt thô máy nhận được">
      {notes.map((n, i) => (
        <rect key={i} x={x(n.onset)} y={y(n.pitch) - 3} width={Math.max(2, x(n.offset) - x(n.onset))} height={6} rx={2} />
      ))}
    </svg>
  )
}

export function HummingPanel({ song, serverOk, projectId, canAppend, melodyLocked = false, chordsLocked = false, onApply, onAppend }: Props) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [countIn, setCountIn] = useState(true)
  const [beat, setBeat] = useState(0)
  const [seconds, setSeconds] = useState(0)
  const [level, setLevel] = useState(0)
  const [take, setTake] = useState<Take | null>(null)
  const [result, setResult] = useState<HummingResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [useKey, setUseKey] = useState(true)
  const [useBpm, setUseBpm] = useState(true)
  const [autoHarmony, setAutoHarmony] = useState(true)
  const [how, setHow] = useState<'append' | 'replace'>('replace')
  const [limits, setLimits] = useState<HummingLimits>(DEFAULT_LIMITS)
  const [job, setJob] = useState<HummingJob | null>(null)
  const maxSeconds = limits.max_minutes * 60

  const ctxRef = useRef<AudioContext | null>(null)
  const recRef = useRef<MicRecorder | null>(null)
  const timers = useRef<number[]>([])
  const fileRef = useRef<HTMLInputElement>(null)
  const songRef = useRef(song)
  songRef.current = song
  const alive = useRef(true)

  const clearTimers = () => {
    timers.current.forEach((t) => clearTimeout(t))
    timers.current = []
  }

  useEffect(() => {
    if (serverOk)
      api.hummingLimits().then(setLimits, () => {
        /* máy chủ cũ chưa có giới hạn mới: dùng mặc định */
      })
  }, [serverOk])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      clearTimers()
      recRef.current?.close()
      void ctxRef.current?.close()
    }
  }, [])
  useEffect(() => () => (take ? URL.revokeObjectURL(take.url) : undefined), [take])

  // Đồng hồ và mức âm khi đang thu.
  useEffect(() => {
    if (phase !== 'recording') return
    const started = performance.now()
    let raf = 0
    const loop = () => {
      const s = (performance.now() - started) / 1000
      setSeconds(s)
      setLevel(recRef.current?.level() ?? 0)
      if (s >= maxSeconds) void stopRecording()
      else raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  const transcribe = async (t: Take) => {
    setPhase('working')
    setError(null)
    setResult(null)
    setJob(null)
    try {
      if (t.blob.size > limits.max_upload_mb * 1024 * 1024) throw new Error(`File quá lớn (tối đa ${limits.max_upload_mb} MB).`)
      // Máy chủ xử lý chạy nền: bản dài mất vài phút, hỏi tiến độ mỗi giây. Mất mạng chốc lát thì hỏi lại.
      let j = await api.startHummingJob(t.blob, t.filename, { bpm: t.fixedBpm ? songRef.current.bpm : undefined, projectId })
      let misses = 0
      while (j.status === 'queued' || j.status === 'running') {
        setJob(j)
        await wait(1000)
        if (!alive.current) return
        try {
          j = await api.hummingJob(j.job_id)
          misses = 0
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 0) || ++misses > 10) throw e
        }
      }
      if (j.status === 'error' || !j.result) throw new Error(j.error ?? 'Máy chủ không trả kết quả.')
      const r = j.result
      setHow(canAppend ? 'append' : 'replace')
      if (!r.melody.length) setError('Không nhận ra nốt nào. Hãy ngân to, rõ, mỗi nốt một tiếng “đa” hoặc “la”, để micro gần hơn.')
      setResult(r)
    } catch (e) {
      setError(serverMessage(e))
    } finally {
      setJob(null)
      if (alive.current) setPhase('idle')
    }
  }

  const startRecording = async () => {
    setError(null)
    if (!recorderSupported()) {
      setError(window.isSecureContext ? 'Trình duyệt này không hỗ trợ thu âm. Bạn có thể tải file ghi âm lên.' : 'Thu âm cần trang chạy HTTPS (hoặc localhost).')
      return
    }
    setPhase('opening')
    try {
      ctxRef.current ??= new AudioContext()
      const ctx = ctxRef.current
      await ctx.resume()
      const rec = new MicRecorder(ctx)
      await rec.open()
      recRef.current = rec
      if (countIn) {
        setPhase('countin')
        const bpm = songRef.current.bpm
        const end = scheduleCountIn(ctx, bpm)
        const startDelay = (end - ctx.currentTime) * 1000
        for (let i = 0; i < 4; i++) timers.current.push(window.setTimeout(() => setBeat(i + 1), startDelay - (4 - i) * (60000 / bpm)))
        timers.current.push(
          window.setTimeout(() => {
            rec.start()
            setBeat(0)
            setPhase('recording')
          }, startDelay),
        )
      } else {
        rec.start()
        setPhase('recording')
      }
    } catch (e) {
      recRef.current?.close()
      recRef.current = null
      setError(micErrorMessage(e))
      setPhase('idle')
    }
  }

  const stopRecording = async () => {
    clearTimers()
    const rec = recRef.current
    if (!rec) return
    if (phase === 'countin') {
      rec.close()
      recRef.current = null
      setPhase('idle')
      return
    }
    try {
      const { blob, filename } = await rec.stop()
      const t = { blob, filename, url: URL.createObjectURL(blob), fixedBpm: countIn }
      setTake(t)
      if (blob.size < 2000) {
        setError('Bản thu quá ngắn. Hãy ngân ít nhất vài giây.')
        setPhase('idle')
      } else await transcribe(t)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('idle')
    } finally {
      rec.close()
      recRef.current = null
      setLevel(0)
    }
  }

  const uploadFile = async (f: File) => {
    const t = { blob: f, filename: f.name, url: URL.createObjectURL(f), fixedBpm: false }
    setTake(t)
    await transcribe(t)
  }

  const recording = phase === 'recording' || phase === 'countin' || phase === 'opening'
  const working = phase === 'working'
  const offline = serverOk === false
  const keyLabel = result ? `${NOTE_NAMES[result.tonic]} ${MODE_VI[result.mode] ?? result.mode}` : ''
  const sameBpm = result ? Math.round(result.bpm) === song.bpm : false
  const sameKey = result ? result.tonic === song.tonic && result.mode === song.mode : false

  return (
    <div className="hum">
      {offline && <p className="hum-warn">Chưa kết nối máy chủ nhận nốt nên chưa thu được. Các phần khác của app vẫn dùng bình thường.</p>}
      <div className="row wrap">
        {!recording ? (
          <button className="btn btn-primary hum-rec" onClick={() => void startRecording()} disabled={working || offline}>
            Bắt đầu ngân
          </button>
        ) : (
          <button className="btn btn-rec-stop hum-rec" onClick={() => void stopRecording()} disabled={phase === 'opening'}>
            {phase === 'countin' ? 'Huỷ' : 'Xong, nhận nốt'}
          </button>
        )}
        <button className="btn" onClick={() => fileRef.current?.click()} disabled={recording || working || offline}>
          Tải file ghi âm
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="audio/*,.wav,.mp3,.m4a,.webm,.ogg"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) void uploadFile(f)
          }}
        />
        <label className="check">
          <input type="checkbox" checked={countIn} onChange={(e) => setCountIn(e.target.checked)} disabled={recording} />
          Đếm 4 nhịp trước khi thu ({song.bpm} BPM)
        </label>
      </div>

      {phase === 'countin' && (
        <div className="hum-live" aria-live="polite">
          <span className="hum-count">{beat || '…'}</span> Chuẩn bị, bắt đầu ngân sau tiếng gõ thứ 4
        </div>
      )}
      {phase === 'recording' && (
        <div className="hum-live" aria-live="polite">
          <span className="hum-dot" aria-hidden /> Đang thu {clock(seconds)} / {clock(maxSeconds)}
          <span className="hum-meter" aria-label="Mức âm micro">
            <span style={{ width: `${Math.round(level * 100)}%` }} />
          </span>
          {seconds > 2 && level < 0.03 && <span className="hint">Micro chưa nghe thấy gì, hãy ngân to hơn.</span>}
        </div>
      )}
      {working && (
        <div className="hum-live" aria-live="polite">
          {job?.status === 'queued'
            ? `Đang xếp hàng, còn ${job.ahead ?? 1} bản trước bạn…`
            : `Đang nghe và nhận nốt… ${Math.round((job?.progress ?? 0) * 100)}%`}
          <span className="hum-meter" aria-label="Tiến độ nhận nốt">
            <span style={{ width: `${Math.round((job?.progress ?? 0) * 100)}%` }} />
          </span>
          {take && take.blob.size > 2_000_000 && <span className="hint">Bản dài xử lý lâu hơn, cứ để trang mở.</span>}
        </div>
      )}
      {error && <p className="hum-error">{error}</p>}

      {take && !recording && <audio className="hum-audio" controls src={take.url} />}

      {result && result.melody.length > 0 && (
        <div className="hum-result">
          <p className="hum-summary">
            Nhận được <b>{result.melody.length} nốt</b> trong {result.duration_sec < 60 ? `${result.duration_sec.toFixed(1)} giây` : clock(result.duration_sec)}, giọng <b>{keyLabel}</b>
            {result.key_confidence < 0.5 && ' (chưa chắc chắn)'}, khoảng <b>{Math.round(result.bpm)} BPM</b>, dài {result.bars} ô nhịp. Xử lý mất{' '}
            {result.elapsed_ms < 60000 ? `${(result.elapsed_ms / 1000).toFixed(1)} giây` : clock(result.elapsed_ms / 1000)}.
            {result.truncated && ` Bản thu dài hơn ${limits.max_minutes} phút nên máy chỉ lấy ${limits.max_minutes} phút đầu.`}
          </p>
          <RawNotes result={result} />
          {song.melody.length > 0 && (
            <div className="seg hum-how" role="group" aria-label="Cách dùng bản ngân">
              <button className={how === 'append' ? 'is-on' : ''} onClick={() => setHow('append')} disabled={!canAppend}>
                Ghép tiếp sau đoạn trước
              </button>
              <button className={how === 'replace' ? 'is-on' : ''} onClick={() => setHow('replace')} disabled={melodyLocked}>
                Thay toàn bộ giai điệu
              </button>
            </div>
          )}
          {song.melody.length > 0 && !canAppend && (
            <p className="hint">
              {song.sections ? 'Bài đã hoàn thiện nên không ghép thêm được. Bấm Hoàn tác để bỏ bước hoàn thiện rồi ghép tiếp.' : `Bài đã đủ dài (${MAX_BARS} ô nhịp).`}
            </p>
          )}
          <div className="hum-opts">
            {how === 'append' && song.melody.length > 0 ? (
              <span className="hint">Đoạn mới giữ giọng {NOTE_NAMES[song.tonic]} và tempo {song.bpm} BPM của bài, tự dịch cho khớp nếu bạn ngân lệch giọng.</span>
            ) : (
              <>
            <label className="check">
              <input type="checkbox" checked={useKey || sameKey} disabled={sameKey} onChange={(e) => setUseKey(e.target.checked)} />
              {sameKey ? `Giọng khớp với bài (${keyLabel})` : `Đổi bài sang giọng ${keyLabel} (bỏ chọn để giữ giọng ${NOTE_NAMES[song.tonic]} hiện tại)`}
            </label>
            <label className="check">
              <input type="checkbox" checked={useBpm && !sameBpm} disabled={sameBpm} onChange={(e) => setUseBpm(e.target.checked)} />
              {sameBpm ? `Tempo khớp với bài (${song.bpm} BPM)` : `Đổi tempo thành ${Math.round(result.bpm)} BPM (đang là ${song.bpm})`}
            </label>
              </>
            )}
            <label className="check">
              <input type="checkbox" checked={autoHarmony && !chordsLocked} disabled={chordsLocked} onChange={(e) => setAutoHarmony(e.target.checked)} />
              {chordsLocked ? 'Hợp âm đang khoá: giữ hợp âm cũ, ô mới thêm thì máy chọn' : 'Tự chọn hợp âm hợp với giai điệu'}
            </label>
          </div>
          <div className="row wrap">
            {how === 'append' && song.melody.length > 0 ? (
              <button
                className="btn btn-primary"
                onClick={() => {
                  onAppend(result, { autoHarmony })
                  setResult(null)
                }}
              >
                Ghép đoạn này vào bài
              </button>
            ) : (
              <button
                className="btn btn-primary"
                disabled={melodyLocked && song.melody.length > 0}
                title={melodyLocked && song.melody.length > 0 ? 'Giai điệu đang khoá: bỏ khoá để thay, hoặc ghép tiếp sau đoạn trước' : undefined}
                onClick={() => {
                  onApply(result, { useKey, useBpm: useBpm && !sameBpm, autoHarmony })
                  setResult(null)
                }}
              >
                Dùng làm giai điệu và phối thành bài
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
