// Thu âm từ micro bằng MediaRecorder, kèm đo mức âm để người dùng thấy micro có nhận tiếng.

const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']

export function recorderSupported(): boolean {
  return typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined'
}

function pickMime(): string | undefined {
  return MIME_TYPES.find((m) => MediaRecorder.isTypeSupported?.(m))
}

function extFor(mime: string): string {
  if (mime.includes('mp4')) return 'm4a'
  if (mime.includes('ogg')) return 'ogg'
  return 'webm'
}

/** Lỗi micro dễ hiểu cho người dùng. */
export function micErrorMessage(e: unknown): string {
  const name = e instanceof DOMException ? e.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'Trình duyệt chưa cho dùng micro. Bấm biểu tượng ổ khoá cạnh thanh địa chỉ để cho phép, hoặc tải file ghi âm lên.'
  if (name === 'NotFoundError') return 'Không tìm thấy micro trên máy này. Bạn có thể tải file ghi âm lên.'
  if (name === 'NotReadableError') return 'Micro đang bị ứng dụng khác dùng. Đóng ứng dụng đó rồi thử lại.'
  return `Không mở được micro: ${e instanceof Error ? e.message : String(e)}`
}

export class MicRecorder {
  private stream: MediaStream | null = null
  private rec: MediaRecorder | null = null
  private chunks: Blob[] = []
  private analyser: AnalyserNode | null = null
  private buf: Float32Array<ArrayBuffer> | null = null
  private source: MediaStreamAudioSourceNode | null = null
  /** Thời điểm (đồng hồ AudioContext) MediaRecorder báo đã bắt đầu thu; null khi chưa thu. */
  startedAt: number | null = null

  private ctx: AudioContext

  constructor(ctx: AudioContext) {
    this.ctx = ctx
  }

  async open() {
    // Tắt khử ồn/tự chỉnh âm lượng: các bộ lọc này làm méo cao độ và nuốt nốt ngân nhỏ.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    })
    this.source = this.ctx.createMediaStreamSource(this.stream)
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 1024
    this.buf = new Float32Array(this.analyser.fftSize)
    this.source.connect(this.analyser)
  }

  start() {
    if (!this.stream) throw new Error('Micro chưa mở')
    const mime = pickMime()
    this.rec = mime ? new MediaRecorder(this.stream, { mimeType: mime }) : new MediaRecorder(this.stream)
    this.chunks = []
    this.startedAt = null
    this.rec.onstart = () => {
      this.startedAt = this.ctx.currentTime
    }
    this.rec.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data)
    }
    this.rec.start(250)
  }

  /** Mức âm 0..1 (RMS, đã nâng lên để dễ nhìn). */
  level(): number {
    if (!this.analyser || !this.buf) return 0
    this.analyser.getFloatTimeDomainData(this.buf)
    let s = 0
    for (const v of this.buf) s += v * v
    return Math.min(1, Math.sqrt(s / this.buf.length) * 6)
  }

  stop(): Promise<{ blob: Blob; filename: string }> {
    const rec = this.rec
    return new Promise((resolve, reject) => {
      if (!rec || rec.state === 'inactive') {
        reject(new Error('Chưa thu âm'))
        return
      }
      rec.onstop = () => {
        const type = rec.mimeType || this.chunks[0]?.type || 'audio/webm'
        resolve({ blob: new Blob(this.chunks, { type }), filename: `ngan-nga.${extFor(type)}` })
      }
      rec.stop()
    })
  }

  close() {
    if (this.rec && this.rec.state !== 'inactive') this.rec.stop()
    this.source?.disconnect()
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.rec = null
    this.source = null
    this.analyser = null
  }
}

/** Tiếng gõ đếm nhịp, phách đầu cao hơn. Trả về thời điểm (giây, theo ctx) kết thúc phần đếm. */
export function scheduleCountIn(ctx: AudioContext, bpm: number, beats = 4): number {
  const beat = 60 / bpm
  const t0 = ctx.currentTime + 0.1
  for (let i = 0; i < beats; i++) {
    const t = t0 + i * beat
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.frequency.value = i === 0 ? 1760 : 1175
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.004)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07)
    osc.connect(g).connect(ctx.destination)
    osc.start(t)
    osc.stop(t + 0.08)
  }
  return t0 + beats * beat
}
