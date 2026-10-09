import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, api, type HummingResult } from './api/client'
import { Player } from './audio/player'
import { renderSongToWav } from './audio/render'
import type { FxDef } from './audio/fx'
import type { LoadState } from './audio/voices'
import { MOODS, NO_MOOD, getMood, progressionToChords } from './core/moods'
import { continueMelody, generateMelody, shiftMelody, varyMelody } from './core/melody'
import { songToMidi } from './core/midi'
import { midiToSong } from './core/midiImport'
import { copyClip, deleteNotes, duplicateNotes, pasteClip, type Clip } from './core/edit'
import { describe as describeCommand, parseCommand, type Command } from './core/commands'
import { remapMelody } from './core/melody'
import { MAX_BARS, SECTION_LABEL, STEPS_PER_BAR, stepSeconds, validateSong, type FxEvent, type Locks, type Note, type Song, type Track, type TrackId, type VocalTrack } from './core/song'
import { varyArrangement } from './core/arrange'
import { STEM_LABEL, soloSong, stemIds } from './core/stems'
import { zipStore, type ZipEntry } from './core/zip'
import {
  addRound,
  appendHumming,
  applyHumming,
  arrangeSong,
  canAppend,
  contentEndBar,
  extendSong,
  formatDuration,
  melodyEndBar,
  resizeSong,
  songSeconds,
  type ApplyOptions,
} from './core/humming'
import { alignLyrics, fixToneHint, lyricsFile, melodyFromLyrics, parseLyrics, splitNotesForLyrics, type ToneHint } from './core/lyrics'
import { harmonize } from './core/suggest'
import { chordPitches, degreeToMidi, isNoChord, midiToDegree, snapToScale, NOTE_NAMES, type Chord } from './core/theory'
import { useSongStore } from './state/store'
import { ChordInspector } from './ui/ChordInspector'
import { CloudList } from './ui/CloudList'
import { FxPanel } from './ui/FxPanel'
import { HummingPanel } from './ui/HummingPanel'
import { LyricsPanel } from './ui/LyricsPanel'
import { Menu } from './ui/Menu'
import { Mixer } from './ui/Mixer'
import { LABEL_W, ZOOMS } from './ui/geometry'
import { Timeline, type LoopRange } from './ui/Timeline'
import { VocalPanel } from './ui/VocalPanel'

const MODE_LABEL: Record<Song['mode'], string> = {
  major: 'trưởng',
  minor: 'thứ',
  dorian: 'Dorian',
  majorPentatonic: 'ngũ cung trưởng',
  minorPentatonic: 'ngũ cung thứ',
}

type Tab = 'start' | 'lyrics' | 'vocal' | 'mixer' | 'fx'
const TABS: { id: Tab; label: string }[] = [
  { id: 'start', label: 'Bắt đầu' },
  { id: 'lyrics', label: 'Lời' },
  { id: 'vocal', label: 'Giọng hát' },
  { id: 'mixer', label: 'Nhạc cụ' },
  { id: 'fx', label: 'Hiệu ứng' },
]

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function safeName(title: string) {
  return (title.trim() || 'bai-hat').replace(/[\\/:*?"<>|]+/g, '').slice(0, 60)
}

const randomSeed = () => Math.floor(Math.random() * 1e9)

/** Bài đủ dài để chứa mọi nốt và hiệu ứng: đặt nốt vào vùng trống cuối timeline là bài tự dài ra. */
function fitContent(s: Song): Song {
  const noteEnd = s.melody.reduce((m, n) => Math.max(m, n.start + n.dur), 0)
  const fxEnd = s.fx.reduce((m, f) => Math.max(m, f.start + 1), 0)
  return extendSong(s, Math.ceil(Math.max(noteEnd, fxEnd) / STEPS_PER_BAR))
}

const CLOUD_ID_KEY = 'aicomposer.cloudId'
function readCloudId(): string | null {
  try {
    return localStorage.getItem(CLOUD_ID_KEY)
  } catch {
    return null
  }
}
function writeCloudId(id: string | null) {
  try {
    if (id) localStorage.setItem(CLOUD_ID_KEY, id)
    else localStorage.removeItem(CLOUD_ID_KEY)
  } catch {
    /* trình duyệt chặn lưu */
  }
}

function BpmField({ bpm, onChange }: { bpm: number; onChange: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    const v = Math.round(Number(draft))
    if (draft !== null && v >= 50 && v <= 180) onChange(v)
    setDraft(null)
  }
  return (
    <label className="lcd lcd-field" title="Tempo (50 đến 180)">
      <input
        inputMode="numeric"
        value={draft ?? String(bpm)}
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        aria-label="Tempo, nhịp mỗi phút"
      />
      <span>BPM</span>
    </label>
  )
}

export default function App() {
  const { history, dispatch } = useSongStore()
  const song = history.present
  const songRef = useRef(song)
  songRef.current = song

  const player = useMemo(() => new Player(), [])
  const [playing, setPlaying] = useState(false)
  const [status, setStatus] = useState<Record<TrackId, LoadState> | null>(null)
  const [lockScale, setLockScale] = useState(true)
  const [grid, setGrid] = useState(2)
  const [zoom, setZoom] = useState(2)
  const [tab, setTab] = useState<Tab>('start')
  const [selectedRaw, setSelectedBar] = useState<number | null>(null)
  const [fxSelected, setFxSelected] = useState('riser')
  const [cursorRaw, setCursor] = useState(0)
  const [candidates, setCandidates] = useState<{ seeds: number[]; active: number } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [customFx, setCustomFx] = useState<FxDef[]>([])
  const [serverOk, setServerOk] = useState<boolean | null>(null)
  const [cloudId, setCloudIdState] = useState<string | null>(readCloudId)
  const [cloudOpen, setCloudOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const clipRef = useRef<Clip | null>(null)
  const [loop, setLoop] = useState<LoopRange | null>(null)
  const [loopOn, setLoopOn] = useState(false)
  const [metronome, setMetronome] = useState(false)
  const [command, setCommand] = useState('')
  const [commandEcho, setCommandEcho] = useState<string | null>(null)
  const midiRef = useRef<HTMLInputElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const timeRef = useRef<HTMLSpanElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const stepW = ZOOMS[zoom]
  // Bài ngắn lại (hoàn tác, mở bài khác) thì chỗ bắt đầu phát và ô đang chọn quay về trong bài.
  const cursor = cursorRaw < song.bars * STEPS_PER_BAR ? cursorRaw : 0
  const selectedBar = selectedRaw !== null && selectedRaw < song.bars ? selectedRaw : null
  const stepWRef = useRef(stepW)
  stepWRef.current = stepW
  const locks: Locks = song.locks ?? {}
  // Vùng lặp nằm ngoài bài (bài ngắn lại) thì coi như không có.
  const loopRange = loop && loop.start < song.bars * STEPS_PER_BAR ? loop : null
  const selectedIds = useMemo(() => {
    const ids = new Set(song.melody.map((n) => n.id))
    return new Set([...selected].filter((id) => ids.has(id)))
  }, [selected, song.melody])

  const update = useCallback((patch: (s: Song) => Song, coalesce?: string) => dispatch({ type: 'update', patch, coalesce }), [dispatch])
  const setField = useCallback((patch: Partial<Song>, coalesce?: string) => update((s) => ({ ...s, ...patch }), coalesce), [update])
  const setTrack = useCallback(
    (id: TrackId, patch: Partial<Track>, coalesce?: string) =>
      update((s) => ({ ...s, tracks: { ...s.tracks, [id]: { ...s.tracks[id], ...patch } } }), coalesce),
    [update],
  )
  const setMelody = useCallback((notes: Note[], coalesce?: string) => update((s) => fitContent({ ...s, melody: notes }), coalesce), [update])
  const setFx = useCallback((fx: FxEvent[]) => update((s) => fitContent({ ...s, fx })), [update])

  // ----- Lời -----
  const lyricsText = song.lyrics ?? ''
  const lines = useMemo(() => parseLyrics(lyricsText), [lyricsText])
  const alignment = useMemo(() => alignLyrics(lines, song.melody), [lines, song.melody])
  // Khoá căn lời: chữ lấy từ bản chụp lúc khoá (gắn theo id nốt), không căn lại khi nốt đổi.
  const syllables = useMemo(
    () => (locks.align && song.lyricMap ? new Map(Object.entries(song.lyricMap)) : lines.length ? alignment.syllableOf : null),
    [locks.align, song.lyricMap, lines.length, alignment],
  )
  const hintIds = useMemo(() => new Set(alignment.hints.map((h) => h.noteId)), [alignment])

  // Đồng bộ nhạc cụ, âm lượng với bộ phát mỗi khi bài đổi.
  useEffect(() => {
    player.onStatus = () => setStatus(player.voices?.status() ?? null)
    player.sync(song)
  }, [player, song])

  // Vạch chạy, đồng hồ, và tự cuộn timeline theo vạch chạy.
  useEffect(() => {
    if (!playing) {
      gridRef.current?.classList.remove('is-playing')
      return
    }
    let raf = 0
    const loop = () => {
      const pos = player.position()
      const g = gridRef.current
      const sc = scrollRef.current
      if (g && pos !== null) {
        const x = pos * stepWRef.current
        g.classList.add('is-playing')
        g.style.setProperty('--ph', `${x}px`)
        if (timeRef.current) timeRef.current.textContent = formatDuration(pos * stepSeconds(songRef.current.bpm))
        if (sc) {
          const left = sc.scrollLeft
          const view = sc.clientWidth - LABEL_W
          if (x < left || x > left + view - 40) sc.scrollLeft = Math.max(0, x - 40)
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [playing, player])

  useEffect(() => () => player.stop(), [player])

  // Vùng lặp và máy đếm nhịp. Đổi vùng lặp khi đang phát thì phát lại từ chỗ đang nghe (hoặc đầu vùng lặp).
  const loopKey = loopOn && loopRange ? `${loopRange.start}-${loopRange.end}` : ''
  useEffect(() => {
    const was = player.position()
    player.setLoop(loopOn ? loopRange : null)
    if (player.playing && was !== null) void player.play(() => songRef.current, Math.floor(was))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player, loopKey])
  useEffect(() => {
    player.metronome = metronome
  }, [player, metronome])

  useEffect(() => {
    api
      .health()
      .then((h) => setServerOk(h.ok))
      .catch(() => setServerOk(false))
  }, [])

  const setCloudId = (id: string | null) => {
    setCloudIdState(id)
    writeCloudId(id)
  }

  const startAt = useCallback(
    async (step: number) => {
      await player.play(() => songRef.current, step)
      setStatus(player.voices?.status() ?? null)
      setPlaying(true)
    },
    [player],
  )

  const stop = useCallback(() => {
    player.stop()
    setPlaying(false)
  }, [player])

  const togglePlay = useCallback(async () => {
    if (player.playing) stop()
    else await startAt(cursor)
  }, [player, stop, startAt, cursor])

  const seek = useCallback(
    (step: number) => {
      setCursor(step)
      if (timeRef.current) timeRef.current.textContent = formatDuration(step * stepSeconds(songRef.current.bpm))
      if (player.playing) void startAt(step)
    },
    [player, startAt],
  )

  const restart = () => {
    if (player.playing) stop()
    void startAt(0)
    setCursor(0)
  }

  const previewNote = useCallback(
    async (pitch: number, track: 'melody' | 'chords' | 'bass' = 'melody', dur = 0.45) => {
      const v = await player.ensure()
      v.setVolumes(songRef.current)
      v.note(track, pitch, player.context!.currentTime + 0.01, dur, 100)
    },
    [player],
  )

  const previewChord = useCallback(
    async (c: Chord) => {
      if (isNoChord(c)) return
      const s = songRef.current
      const v = await player.ensure()
      v.setVolumes(s)
      const t = player.context!.currentTime + 0.01
      for (const p of chordPitches(c, s.tonic, s.mode, 4)) v.note('chords', p, t, 1.2, 85)
      v.note('bass', chordPitches(c, s.tonic, s.mode, 2)[0], t, 1.2, 90)
    },
    [player],
  )

  const audition = useCallback(
    async (id: TrackId) => {
      const s = songRef.current
      const v = await player.ensure()
      v.setVolumes({ ...s, tracks: { ...s.tracks, [id]: { ...s.tracks[id], muted: false } } })
      const t0 = player.context!.currentTime + 0.05
      const beat = 60 / s.bpm
      if (id === 'drums') {
        const pat: [number, 'kick' | 'snare' | 'hihat-close'][] = [[0, 'kick'], [0, 'hihat-close'], [0.5, 'hihat-close'], [1, 'snare'], [1, 'hihat-close'], [1.5, 'hihat-close'], [2, 'kick'], [2, 'hihat-close'], [2.5, 'kick'], [3, 'snare'], [3, 'hihat-close'], [3.5, 'hihat-close']]
        for (const [b, sound] of pat) v.drumHit(sound, t0 + b * beat, 100)
        return
      }
      const octave = id === 'bass' ? 2 : id === 'chords' ? 3 : 4
      const base = midiToDegree(degreeToMidi(0, s.tonic, s.mode) + (octave + 1) * 12, s.tonic, s.mode)
      const run = id === 'chords' ? [0, 2, 4, 7] : [0, 1, 2, 3, 4, 3, 2, 0]
      run.forEach((d, i) => v.note(id, degreeToMidi(base + d, s.tonic, s.mode), t0 + i * beat * 0.5, beat * (id === 'chords' ? 1.5 : 0.45), 95))
    },
    [player],
  )

  const previewFx = async (id: string) => {
    const v = await player.ensure()
    v.setVolumes(songRef.current)
    await v.prepareFx([id])
    v.fx(id, player.context!.currentTime + 0.02)
  }

  // ----- Khoá -----
  const setLock = (key: keyof Locks, on: boolean) =>
    update((s) => {
      const next = { ...s, locks: { ...s.locks, [key]: on } }
      if (key === 'align') next.lyricMap = on ? Object.fromEntries(alignLyrics(parseLyrics(s.lyrics ?? ''), s.melody).syllableOf) : undefined
      return next
    })
  const melodyLocked = !!locks.melody
  const chordsLocked = !!locks.chords
  const lockedMsg = () => setMessage('Giai điệu đang khoá. Bỏ Khoá giai điệu trên thanh công cụ để sửa.')

  // ----- Chọn nhiều nốt, chép, dán -----
  const pasteAt = () => {
    const pos = player.position()
    const step = pos !== null ? Math.floor(pos / 4) * 4 : cursor
    return step
  }
  const editMax = MAX_BARS * STEPS_PER_BAR
  const copySel = () => {
    const clip = copyClip(song.melody, selectedIds)
    if (!clip) return false
    clipRef.current = clip
    setMessage(`Đã chép ${clip.notes.length} nốt. Ctrl+V để dán tại chỗ phát.`)
    return true
  }
  const pasteClipAction = () => {
    if (!clipRef.current) return
    if (melodyLocked) return lockedMsg()
    const at = pasteAt()
    const { melody, ids } = pasteClip(songRef.current.melody, clipRef.current, at, editMax)
    setMelody(melody)
    setSelected(new Set(ids))
  }
  const duplicateSel = () => {
    if (!selectedIds.size) return
    if (melodyLocked) return lockedMsg()
    const { melody, ids } = duplicateNotes(songRef.current.melody, selectedIds, editMax)
    setMelody(melody)
    setSelected(new Set(ids))
  }
  const deleteSel = () => {
    if (!selectedIds.size) return
    if (melodyLocked) return lockedMsg()
    setMelody(deleteNotes(songRef.current.melody, selectedIds))
    setSelected(new Set())
  }

  // ----- Giai điệu -----
  const makeCandidates = () => {
    const base = randomSeed()
    const seeds = [base, base + 1, base + 2]
    setCandidates({ seeds, active: 0 })
    update((s) => ({ ...s, seed: base, melody: generateMelody(s, { seed: base }) }), 'candidates')
    if (!player.playing) void startAt(cursor)
  }
  const pickCandidate = (i: number) => {
    if (!candidates) return
    setCandidates({ ...candidates, active: i })
    update((s) => ({ ...s, seed: candidates.seeds[i], melody: generateMelody(s, { seed: candidates.seeds[i] }) }), 'candidates')
  }
  // Viết tiếp: giai điệu đã kín bài thì nối thêm 4 ô rồi viết vào đó.
  const continueAction = () =>
    update((s) => {
      const base = melodyEndBar(s) >= s.bars ? extendSong(s, s.bars + 4) : s
      return { ...base, melody: continueMelody(base, randomSeed()) }
    })

  // ----- Hợp âm -----
  const nextProgression = () => {
    const mood = getMood(song.moodId)
    const cur = song.chords.slice(0, 4).map((c) => c.degree).join(',')
    const idx = mood.progressions.findIndex((p) => p.join(',') === cur)
    const next = mood.progressions[(idx + 1) % mood.progressions.length]
    update((s) => ({ ...s, chords: progressionToChords(next, s.bars, s.chords[0]?.seventh ?? mood.sevenths) }))
  }

  const toggleLock = () => {
    const next = !lockScale
    setLockScale(next)
    if (next && song.melody.some((n) => snapToScale(n.pitch, song.tonic, song.mode) !== n.pitch)) {
      update((s) => ({ ...s, melody: s.melody.map((n) => ({ ...n, pitch: snapToScale(n.pitch, s.tonic, s.mode) })) }))
      setMessage('Đã đưa các nốt lạc về thang âm. Bấm Hoàn tác nếu muốn giữ như cũ.')
    }
  }

  const toggleSevenths = () =>
    update((s) => {
      const on = !s.chords.find((c) => !isNoChord(c))?.seventh
      return { ...s, chords: s.chords.map((c) => (isNoChord(c) ? c : { ...c, seventh: on })) }
    })
  // Bật Lặp khi chưa kéo vùng: lặp 4 ô tính từ ô đang đứng.
  const defaultLoop = (): LoopRange => {
    const bar = Math.floor(cursor / STEPS_PER_BAR)
    const start = Math.max(0, Math.min(bar, song.bars - 4)) * STEPS_PER_BAR
    return { start, end: Math.min(song.bars * STEPS_PER_BAR, start + 4 * STEPS_PER_BAR) }
  }

  const contentEnd = contentEndBar(song)
  const trimEnd = () => update((s) => ({ ...s, bars: contentEndBar(s), chords: s.chords.slice(0, contentEndBar(s)) }))

  // ----- Xuất / lưu -----
  const exportMidi = () => {
    download(new Blob([songToMidi(song) as BlobPart], { type: 'audio/midi' }), `${safeName(song.title)}.mid`)
  }
  const exportWav = async () => {
    const loops = song.bars > 16 ? 1 : 2
    setBusy('Đang xuất WAV…')
    try {
      const v = player.voices
      const { blob, usedFallback, vocalMissing } = await renderSongToWav(song, {
        // Bài ngắn xuất 2 vòng cho đủ nghe; bài dài xuất đúng 1 lần.
        loops,
        customFx,
        customBuffers: v?.customBuffers,
      })
      download(blob, `${safeName(song.title)}.wav`)
      setMessage(vocalMissing ? 'Đã xuất WAV, nhưng chưa tải được giọng hát từ máy chủ nên bản này thiếu giọng.' : usedFallback ? 'Đã xuất WAV. Một số nhạc cụ chưa tải được nên dùng synth dự phòng (kiểm tra kết nối mạng).' : `Đã xuất WAV (${formatDuration(songSeconds(song) * loops)}).`)
    } catch (e) {
      setMessage(`Xuất WAV lỗi: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }
  // ----- Xuất từng track (stems) và gói trọn bài -----
  const wavLoops = (s: Song) => (s.bars > 16 ? 1 : 2)
  /** Render từng track riêng (cùng cách trộn và master), báo tiến độ qua nhãn menu Xuất. */
  const renderStems = async (s: Song): Promise<{ name: string; blob: Blob }[]> => {
    const ids = stemIds(s)
    const out: { name: string; blob: Blob }[] = []
    for (const [i, id] of ids.entries()) {
      setBusy(`Đang xuất track ${i + 1}/${ids.length}…`)
      const { blob } = await renderSongToWav(soloSong(s, id), { loops: wavLoops(s), customFx, customBuffers: player.voices?.customBuffers })
      out.push({ name: `${safeName(s.title)} - ${STEM_LABEL[id]}.wav`, blob })
    }
    return out
  }
  const exportStems = async () => {
    setBusy('Đang xuất từng track…')
    try {
      const stems = await renderStems(songRef.current)
      // Tải lần lượt, cách nhau một chút để trình duyệt không gộp mất file.
      for (const st of stems) {
        download(st.blob, st.name)
        await new Promise((r) => setTimeout(r, 300))
      }
      setMessage(stems.length ? `Đã xuất ${stems.length} track riêng.` : 'Bài chưa có track nào có tiếng để xuất.')
    } catch (e) {
      setMessage(`Xuất từng track lỗi: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }
  const exportZip = async () => {
    const s = songRef.current
    const name = safeName(s.title)
    setBusy('Đang xuất bản mix…')
    try {
      const enc = new TextEncoder()
      const bytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer())
      const mix = await renderSongToWav(s, { loops: wavLoops(s), customFx, customBuffers: player.voices?.customBuffers })
      const files: ZipEntry[] = [
        { name: `${name}.wav`, data: await bytes(mix.blob) },
        { name: `${name}.mid`, data: songToMidi(s) },
        { name: `${name}.aicomposer.json`, data: enc.encode(JSON.stringify(s, null, 2)) },
      ]
      if (s.lyrics?.trim()) files.push({ name: `${name} - loi.txt`, data: enc.encode(lyricsFile(s.title, s.lyrics)) })
      for (const st of await renderStems(s)) files.push({ name: `stems/${st.name}`, data: await bytes(st.blob) })
      setBusy('Đang đóng gói…')
      download(new Blob([zipStore(files) as BlobPart], { type: 'application/zip' }), `${name}.zip`)
      setMessage(mix.vocalMissing ? 'Đã xuất gói .zip, nhưng chưa tải được giọng hát từ máy chủ nên bản mix thiếu giọng.' : `Đã xuất gói .zip (${files.length} file).`)
    } catch (e) {
      setMessage(`Xuất gói lỗi: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }

  // ----- Giọng hát -----
  const setVocal = useCallback((v: VocalTrack | undefined) => update((s) => ({ ...s, vocal: v })), [update])
  const patchVocal = useCallback(
    (patch: Partial<VocalTrack>, coalesce?: string) => update((s) => (s.vocal ? { ...s, vocal: { ...s.vocal, ...patch } } : s), coalesce),
    [update],
  )
  /** Nhạc nền khi thu giọng: bỏ giọng cũ, bắt đầu đúng sau tiếng đếm nhịp. */
  const playBacking = async (fromStep: number, at: number) => {
    // Thu giọng chạy thẳng một mạch: tạm bỏ vùng lặp, dừng thu thì đặt lại.
    player.setLoop(null)
    await player.play(() => ({ ...songRef.current, vocal: undefined }), fromStep, at)
    setStatus(player.voices?.status() ?? null)
    setPlaying(true)
  }

  const exportLyrics = () => {
    download(new Blob([lyricsFile(song.title, lyricsText)], { type: 'text/plain;charset=utf-8' }), `${safeName(song.title)} - loi.txt`)
  }
  const saveJson = () => {
    download(new Blob([JSON.stringify(song, null, 2)], { type: 'application/json' }), `${safeName(song.title)}.aicomposer.json`)
  }
  const openJson = async (file: File) => {
    try {
      const data = JSON.parse(await file.text())
      const err = validateSong(data)
      if (err) {
        setMessage(`Không mở được: ${err}`)
        return
      }
      stop()
      dispatch({ type: 'load', song: data as Song })
      setCloudId(null)
      setCandidates(null)
      setMessage(`Đã mở "${(data as Song).title}".`)
    } catch {
      setMessage('Không mở được: file không phải JSON hợp lệ.')
    }
  }

  const uploadFx = async (file: File): Promise<string | null> => {
    try {
      const v = await player.ensure()
      const buf = await player.context!.decodeAudioData(await file.arrayBuffer())
      const id = `custom:${file.name}:${Date.now()}`
      const def: FxDef = { id, label: file.name.replace(/\.[^.]+$/, '').slice(0, 30), group: 'Của bạn', source: { type: 'custom' } }
      v.customBuffers.set(id, buf)
      const next = [...customFx, def]
      v.customFx = next
      setCustomFx(next)
      return id
    } catch {
      return null
    }
  }

  // ----- Ngân nga -> bài -----
  const applyHum = (r: HummingResult, opts: ApplyOptions) => {
    const cur = songRef.current
    const { song: applied, dropped } = applyHumming(cur, r, chordsLocked ? { ...opts, autoHarmony: false } : opts)
    // Khoá hợp âm: giữ hợp âm cũ ở các ô đã có, ô mới thêm thì dùng hợp âm máy chọn.
    const next = chordsLocked ? { ...applied, chords: applied.chords.map((c, i) => (i < cur.chords.length ? cur.chords[i] : c)) } : applied
    update(() => next)
    setCandidates(null)
    setMessage(
      `Đã đưa ${next.melody.length} nốt vào bài${opts.autoHarmony ? ' và chọn hợp âm theo giai điệu' : ''}.` +
        (dropped ? ` Bỏ ${dropped} nốt vượt quá ${MAX_BARS} ô nhịp.` : '') +
        ' Bấm Hoàn tác nếu chưa ưng.',
    )
    void startAt(0)
    setCursor(0)
  }

  const appendHum = (r: HummingResult, opts: { autoHarmony: boolean }) => {
    const { song: next, dropped } = appendHumming(songRef.current, r, chordsLocked ? { autoHarmony: false } : opts)
    const added = next.melody.length - songRef.current.melody.length
    update(() => next)
    setCandidates(null)
    setMessage(`Đã ghép ${added} nốt vào sau, bài giờ dài ${next.bars} ô nhịp.` + (dropped ? ` Bỏ ${dropped} nốt vượt quá ${MAX_BARS} ô.` : '') + ' Ngân tiếp đoạn nữa hoặc bấm Hoàn thiện thành bài.')
  }

  const replay = () => {
    stop()
    setCursor(0)
    void startAt(0)
  }

  const arrange = () => {
    const next = arrangeSong(songRef.current, randomSeed())
    update(() => next)
    setCandidates(null)
    setMessage(`Đã hoàn thiện thành bài dài ${formatDuration(songSeconds(next))}. Muốn dài hơn: thêm lượt đoạn chính và điệp khúc, hoặc viết tiếp vào vùng trống cuối timeline.`)
    replay()
  }

  const moreRound = () => {
    const next = addRound(songRef.current, randomSeed())
    if (!next) {
      setMessage(`Không thêm được: bài đã gần ${MAX_BARS} ô nhịp.`)
      return
    }
    update(() => next)
    setMessage(`Đã thêm một lượt đoạn chính và điệp khúc, bài giờ dài ${formatDuration(songSeconds(next))}.`)
  }

  // ----- Lời -> nhạc -----
  const writeFromLyrics = () => {
    update((s) => {
      const { melody, bars } = melodyFromLyrics(s, lines, randomSeed())
      const sized = { ...resizeSong(s, Math.max(4, Math.ceil(bars / 4) * 4)), melody }
      return { ...sized, chords: harmonize(sized) }
    })
    setCandidates(null)
    setMessage('Đã viết giai điệu theo lời và chọn hợp âm hợp với nó. Bấm lại để thử phương án khác, hoặc Hoàn tác.')
    replay()
  }
  const splitForLyrics = () => {
    const { melody, added } = splitNotesForLyrics(songRef.current, lines)
    update((s) => ({ ...s, melody }))
    setMessage(`Đã chẻ ${added} nốt để đủ chỗ cho chữ.`)
  }
  const fixHint = (h: ToneHint) => {
    update((s) => ({ ...s, melody: fixToneHint(s, h) }))
    void previewNote(fixToneHint(songRef.current, h).find((n) => n.id === h.noteId)?.pitch ?? h.prevPitch)
  }

  // ----- Mở MIDI -----
  const openMidi = async (file: File) => {
    try {
      const { song: next, melodyTrack, hasChords, hasLyrics } = midiToSong(await file.arrayBuffer(), songRef.current, file.name)
      stop()
      dispatch({ type: 'load', song: next })
      setCloudId(null)
      setCandidates(null)
      setSelected(new Set())
      setLoop(null)
      setMessage(
        `Đã mở MIDI: ${next.melody.length} nốt từ track “${melodyTrack}”, ${next.bpm} BPM, ${next.bars} ô. ` +
          (hasChords ? 'Hợp âm lấy từ file.' : 'Hợp âm do máy chọn theo giai điệu.') +
          (hasLyrics ? ' Có lời đi kèm.' : ''),
      )
    } catch (e) {
      setMessage(`Không mở được MIDI: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ----- Bảo máy làm gì -----
  const runCommand = (cmd: Command): string | null => {
    const s = songRef.current
    switch (cmd.kind) {
      case 'tempo': {
        const bpm = Math.round(Math.min(180, Math.max(50, cmd.bpm ?? s.bpm + (cmd.delta ?? 0))))
        setField({ bpm })
        return null
      }
      case 'mood':
        dispatch({ type: 'mood', moodId: cmd.moodId })
        setCandidates(null)
        return null
      case 'key':
      case 'transpose': {
        const tonic = cmd.kind === 'key' ? cmd.tonic : (((s.tonic + cmd.semitones) % 12) + 12) % 12
        const mode = cmd.kind === 'key' ? cmd.mode : s.mode
        update((x) => ({
          ...x,
          tonic,
          mode,
          melody: cmd.kind === 'transpose' ? x.melody.map((n) => ({ ...n, pitch: n.pitch + cmd.semitones })) : remapMelody(x.melody, x, { tonic, mode }),
        }))
        return null
      }
      case 'arrange':
        if (!s.melody.length) return 'cần có giai điệu trước khi hoàn thiện'
        if (s.sections) return 'bài đã hoàn thiện rồi (thử “thêm điệp khúc”)'
        arrange()
        return null
      case 'addRound':
        if (!s.sections) {
          if (!s.melody.length) return 'cần có giai điệu trước'
          arrange()
          return null
        }
        moreRound()
        return null
      case 'extend':
        update((x) => extendSong(x, Math.min(MAX_BARS, x.bars + cmd.bars)))
        return null
      case 'melody':
        if (melodyLocked) return 'giai điệu đang khoá'
        if (cmd.action === 'new') makeCandidates()
        else if (!s.melody.length) return 'chưa có giai điệu'
        else if (cmd.action === 'continue') continueAction()
        else if (cmd.action === 'vary') update((x) => ({ ...x, melody: varyMelody(x, randomSeed()) }))
        else if (cmd.action === 'up') update((x) => ({ ...x, melody: shiftMelody(x, 1) }))
        else if (cmd.action === 'down') update((x) => ({ ...x, melody: shiftMelody(x, -1) }))
        else setMelody([])
        return null
      case 'chords':
        if (chordsLocked) return 'hợp âm đang khoá'
        if (cmd.action === 'harmonize') {
          if (!s.melody.length) return 'cần có giai điệu trước'
          update((x) => ({ ...x, chords: harmonize(x) }))
        } else if (cmd.action === 'next') nextProgression()
        else toggleSevenths()
        return null
      case 'instrument':
        setTrack(cmd.track, { instrument: cmd.instrument, muted: false })
        return null
      case 'drums':
        update((x) => ({
          ...x,
          drumStyle: cmd.on && x.drumStyle === 'none' ? getMood(x.moodId === NO_MOOD ? 'vui' : x.moodId).drumStyle : x.drumStyle,
          tracks: { ...x.tracks, drums: { ...x.tracks.drums, muted: !cmd.on } },
        }))
        return null
      case 'volume': {
        const t = s.tracks[cmd.track]
        setTrack(cmd.track, { volume: Math.max(0, Math.min(1, t.volume + cmd.delta)), muted: false })
        return null
      }
      case 'transport':
        if (cmd.action === 'play') void startAt(cursor)
        else stop()
        return null
      case 'metronome':
        setMetronome(cmd.on)
        return null
      case 'loop':
        if (cmd.on && !loopRange) setLoop(defaultLoop())
        setLoopOn(cmd.on)
        return null
    }
  }
  const submitCommand = () => {
    const text = command.trim()
    if (!text) return
    const { commands, unknown } = parseCommand(text)
    const done: string[] = []
    const failed: string[] = []
    for (const c of commands) {
      const err = runCommand(c)
      if (err) failed.push(`${describeCommand(c)}: ${err}`)
      else done.push(describeCommand(c))
    }
    const parts = []
    if (done.length) parts.push(`Đã làm: ${done.join(', ')}.`)
    if (failed.length) parts.push(`Chưa làm được: ${failed.join('; ')}.`)
    if (unknown.length)
      parts.push(`Chưa hiểu “${unknown.join('”, “')}”. Thử: nhanh hơn, tempo 90, đổi sang buồn, giọng La thứ, thêm điệp khúc, bỏ trống, dùng sáo trúc, tắt trống.`)
    setCommandEcho(parts.join(' '))
    if (!unknown.length) setCommand('')
  }

  // ----- Cloud -----
  const saveCloud = async () => {
    setSaving(true)
    try {
      let saved
      try {
        saved = cloudId ? await api.updateProject(cloudId, song) : await api.createProject(song)
      } catch (e) {
        // Bài trên cloud đã bị xoá ở nơi khác: tạo bài mới.
        if (e instanceof ApiError && e.status === 404) saved = await api.createProject(song)
        else throw e
      }
      setCloudId(saved.id)
      setMessage(`Đã lưu “${saved.title}” lên cloud.`)
    } catch (e) {
      setMessage(`Lưu cloud lỗi: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }
  const openCloud = async (id: string) => {
    try {
      const p = await api.getProject(id)
      const err = validateSong(p.song)
      if (err) {
        setMessage(`Không mở được: ${err}`)
        return
      }
      stop()
      dispatch({ type: 'load', song: p.song })
      setCloudId(p.id)
      setCandidates(null)
      setCloudOpen(false)
      setMessage(`Đã mở “${p.title}” từ cloud.`)
    } catch (e) {
      setMessage(`Không mở được: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Phím tắt: Space phát/dừng, Home về đầu, Ctrl+Z hoàn tác, Ctrl+Y / Ctrl+Shift+Z làm lại.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      if (e.code === 'Space') {
        e.preventDefault()
        void togglePlay()
      } else if (e.key === 'Home') {
        e.preventDefault()
        seek(0)
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        dispatch({ type: e.shiftKey ? 'redo' : 'undo' })
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        dispatch({ type: 'redo' })
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
        if (copySel()) e.preventDefault()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') {
        if (copySel()) {
          e.preventDefault()
          deleteSel()
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
        e.preventDefault()
        pasteClipAction()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        duplicateSel()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        setSelected(new Set(songRef.current.melody.map((n) => n.id)))
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedIds.size) {
          e.preventDefault()
          deleteSel()
        }
      } else if (e.key === 'Escape') {
        setSelected(new Set())
      } else if (e.key.toLowerCase() === 'l' && !e.ctrlKey && !e.metaKey) {
        if (!loopRange) setLoop(defaultLoop())
        setLoopOn((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  useEffect(() => {
    if (!message) return
    const t = setTimeout(() => setMessage(null), 6000)
    return () => clearTimeout(t)
  }, [message])

  const total = formatDuration(songSeconds(song))
  const cursorTime = formatDuration(cursor * stepSeconds(song.bpm))

  return (
    <div className="app">
      <header className="bar">
        <div className="bar-left">
          <span className="wordmark">AIComposer</span>
          <input className="title-input" value={song.title} onChange={(e) => setField({ title: e.target.value }, 'title')} aria-label="Tên bài hát" />
        </div>

        <div className="transport" role="group" aria-label="Điều khiển phát">
          <button className="btn btn-quiet" onClick={restart} title="Phát lại từ đầu (Home để về đầu)">
            Từ đầu
          </button>
          <button className={`btn btn-play${playing ? ' is-on' : ''}`} onClick={() => void togglePlay()} title="Space">
            {playing ? 'Dừng' : 'Phát'}
          </button>
          <div className="lcd" aria-label="Vị trí và độ dài bài">
            <span ref={timeRef}>{cursorTime}</span>
            <span className="lcd-dim">/ {total}</span>
          </div>
          <BpmField bpm={song.bpm} onChange={(bpm) => setField({ bpm })} />
          <div className="lcd" title="Giọng của bài">
            <span>
              {NOTE_NAMES[song.tonic]} {MODE_LABEL[song.mode]}
            </span>
          </div>
          <div className="lcd lcd-dim-all" title="Số ô nhịp">
            <span>{song.bars} ô</span>
          </div>
        </div>

        <div className="bar-right">
          <button className="btn btn-quiet" onClick={() => dispatch({ type: 'undo' })} disabled={!history.past.length} title="Ctrl+Z">
            Hoàn tác
          </button>
          <button className="btn btn-quiet" onClick={() => dispatch({ type: 'redo' })} disabled={!history.future.length} title="Ctrl+Y">
            Làm lại
          </button>
          <Menu
            label={busy ?? 'Xuất'}
            items={[
              { label: 'Âm thanh WAV', hint: 'Nghe trên mọi máy', onClick: () => void exportWav(), disabled: !!busy },
              { label: 'Từng track (stems)', hint: 'Mỗi track một file WAV', onClick: () => void exportStems(), disabled: !!busy },
              { label: 'Gói trọn bài (.zip)', hint: 'WAV, MIDI, lời, file bài và stems', onClick: () => void exportZip(), disabled: !!busy },
              { label: 'MIDI', hint: 'Mở bằng phần mềm làm nhạc, có kèm lời', onClick: exportMidi },
              { label: 'Lời bài hát (.txt)', onClick: exportLyrics, disabled: !lines.length },
            ]}
          />
          <Menu
            label="Tệp"
            items={[
              { label: 'Bài của tôi trên cloud', onClick: () => setCloudOpen(true), disabled: !serverOk },
              { label: 'Lưu file về máy', hint: '.aicomposer.json', onClick: saveJson },
              { label: 'Mở file từ máy', onClick: () => fileRef.current?.click() },
              { label: 'Mở file MIDI', hint: '.mid, .kar: lấy giai điệu, hợp âm, lời', onClick: () => midiRef.current?.click() },
            ]}
          />
          <button
            className="btn btn-primary"
            onClick={() => void saveCloud()}
            disabled={saving || !serverOk}
            title={serverOk ? (cloudId ? 'Cập nhật bài đã lưu trên cloud' : 'Lưu bài lên cloud') : 'Chưa kết nối máy chủ'}
          >
            {saving ? 'Đang lưu…' : 'Lưu cloud'}
          </button>
          <input
            ref={midiRef}
            type="file"
            accept=".mid,.midi,.kar,audio/midi"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) void openMidi(f)
            }}
          />
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) void openJson(f)
            }}
          />
        </div>
      </header>

      <div className="workspace">
        <aside className="side" aria-label="Bảng công cụ">
          <div className="tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab${tab === t.id ? ' is-on' : ''}`} onClick={() => setTab(t.id)}>
                {t.label}
                {t.id === 'lyrics' && alignment.hints.length > 0 && <span className="tab-count">{alignment.hints.length}</span>}
              </button>
            ))}
          </div>
          <div className="side-body">
            {tab === 'start' && (
              <>
                <section className="side-sec">
                  <h3 className="side-h">1. Chọn cảm xúc</h3>
                  <p className="hint">
                    Mỗi cảm xúc chọn sẵn giọng, tempo, vòng hợp âm, nhạc cụ và nhịp trống. Bấm lại cảm xúc đang chọn để bỏ chọn: ô nhịp trở về trống, giai điệu vẫn giữ.
                  </p>
                  <div className="moods">
                    {MOODS.map((m) => (
                      <button
                        key={m.id}
                        className={`mood mood-${m.id}${song.moodId === m.id ? ' is-on' : ''}`}
                        onClick={() => {
                          dispatch({ type: 'mood', moodId: song.moodId === m.id ? NO_MOOD : m.id })
                          setCandidates(null)
                        }}
                        aria-pressed={song.moodId === m.id}
                      >
                        <span className="mood-label">{m.label}</span>
                        <span className="mood-hint">{m.hint}</span>
                      </button>
                    ))}
                  </div>
                </section>

                <section className="side-sec">
                  <h3 className="side-h">2. Ngân nga ý tưởng</h3>
                  <p className="hint">Cứ ngân “la la” hoặc “đa đa” câu nhạc trong đầu (tối đa 60 giây). Máy nghe ra cao độ, nhịp và giọng rồi phối thành bài.</p>
                  <HummingPanel
                    song={song}
                    serverOk={serverOk}
                    projectId={cloudId ?? undefined}
                    canAppend={canAppend(song)}
                    melodyLocked={melodyLocked}
                    chordsLocked={chordsLocked}
                    onApply={applyHum}
                    onAppend={appendHum}
                  />
                </section>

                <section className="side-sec">
                  <h3 className="side-h">3. Hoàn thiện thành bài</h3>
                  {song.sections ? (
                    <>
                      <div className="structure" aria-label="Cấu trúc bài">
                        {song.sections.map((x) => (
                          <span key={x.start} className={`sec-pill sec-${x.kind}`} style={{ flexGrow: x.bars }}>
                            {SECTION_LABEL[x.kind]}
                          </span>
                        ))}
                      </div>
                      <p className="hint">
                        Bài dài {total}. Muốn dài nữa thì thêm một lượt, hoặc đặt nốt vào vùng trống cuối timeline: bài tự dài ra theo.
                      </p>
                      <button className="btn" onClick={moreRound}>
                        Thêm lượt đoạn chính và điệp khúc
                      </button>
                    </>
                  ) : (
                    <>
                      <p className="hint">
                        {song.melody.length
                          ? `Đang có ${melodyEndBar(song)} ô giai điệu. Máy sẽ thêm dạo đầu, điệp khúc (đệm dày hơn) và phần kết.`
                          : 'Cần có giai điệu trước: ngân nga, viết theo lời, hoặc bấm Tạo giai điệu trên timeline.'}
                      </p>
                      <button className="btn btn-primary" onClick={arrange} disabled={!song.melody.length}>
                        Hoàn thiện thành bài
                      </button>
                    </>
                  )}
                </section>
              </>
            )}
            {tab === 'lyrics' && (
              <LyricsPanel
                text={lyricsText}
                lines={lines}
                alignment={alignment}
                hasMelody={song.melody.length > 0}
                onText={(text) => !locks.lyrics && setField({ lyrics: text }, 'lyrics')}
                onMelodyFromLyrics={writeFromLyrics}
                onSplitNotes={splitForLyrics}
                onFixHint={fixHint}
                onSeekLine={(step) => {
                  seek(step)
                  if (!player.playing) void startAt(step)
                }}
                onDownload={exportLyrics}
                locks={locks}
                onLock={setLock}
              />
            )}
            {tab === 'vocal' && (
              <VocalPanel
                song={song}
                serverOk={serverOk}
                projectId={cloudId ?? undefined}
                cursor={cursor}
                onEnsureAudio={async () => {
                  await player.ensure()
                  return player.context!
                }}
                onPlayBacking={playBacking}
                onStopPlayback={() => {
                  stop()
                  player.setLoop(loopOn ? loopRange : null)
                }}
                onSetVocal={setVocal}
                onPatchVocal={patchVocal}
              />
            )}
            {tab === 'mixer' && (
              <Mixer
                song={song}
                status={status}
                onTrack={setTrack}
                onField={setField}
                onAudition={(id) => void audition(id)}
                onVary={() => {
                  update((s) => varyArrangement(s, randomSeed()))
                  setMessage(song.sections ? 'Đã phối lại từng đoạn. Bấm Phát để nghe, bấm lại để thử phương án khác, hoặc Hoàn tác.' : 'Đã đổi cách đệm cho cả bài. Bấm Hoàn tác nếu chưa ưng.')
                }}
                onVocal={patchVocal}
              />
            )}
            {tab === 'fx' && (
              <FxPanel
                song={song}
                customFx={customFx}
                selected={fxSelected}
                onSelect={setFxSelected}
                onPreview={(id) => void previewFx(id)}
                onChange={setFx}
                onVolume={(v) => setField({ fxVolume: v }, 'fxvol')}
                onUpload={uploadFx}
              />
            )}
          </div>
        </aside>

        <section className="editor" aria-label="Timeline">
          <form
            className="cmd"
            onSubmit={(e) => {
              e.preventDefault()
              submitCommand()
            }}
          >
            <label className="side-h" htmlFor="cmd-input">
              Bảo máy làm gì
            </label>
            <input
              id="cmd-input"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="Ví dụ: nhanh hơn, đổi sang buồn, giọng La thứ, thêm điệp khúc, dùng sáo trúc"
              autoComplete="off"
            />
            <button className="btn btn-sm btn-primary" type="submit" disabled={!command.trim()}>
              Làm
            </button>
          </form>
          {commandEcho && (
            <p className="hint cmd-echo" role="status">
              {commandEcho}
            </p>
          )}
          <div className="toolbar">
            <div className="tool-group" role="group" aria-label="Giai điệu">
              <button className="btn btn-primary btn-sm" onClick={makeCandidates} disabled={melodyLocked}>
                Tạo giai điệu
              </button>
              {candidates && (
                <div className="seg" role="group" aria-label="Chọn phương án giai điệu">
                  {candidates.seeds.map((_, i) => (
                    <button key={i} className={candidates.active === i ? 'is-on' : ''} onClick={() => pickCandidate(i)} disabled={melodyLocked}>
                      Phương án {i + 1}
                    </button>
                  ))}
                </div>
              )}
              <button className="btn btn-sm" onClick={continueAction} disabled={melodyLocked || !song.melody.length || song.bars + 4 > MAX_BARS}>
                Viết tiếp
              </button>
              <button className="btn btn-sm" onClick={() => update((s) => ({ ...s, melody: varyMelody(s, randomSeed()) }))} disabled={melodyLocked || !song.melody.length}>
                Biến tấu
              </button>
              <button className="btn btn-sm" onClick={() => update((s) => ({ ...s, melody: shiftMelody(s, 1) }))} disabled={melodyLocked || !song.melody.length}>
                Cao hơn
              </button>
              <button className="btn btn-sm" onClick={() => update((s) => ({ ...s, melody: shiftMelody(s, -1) }))} disabled={melodyLocked || !song.melody.length}>
                Thấp hơn
              </button>
              <button className="btn btn-sm btn-quiet" onClick={() => setMelody([])} disabled={melodyLocked || !song.melody.length}>
                Xoá giai điệu
              </button>
            </div>
            <div className="tool-group" role="group" aria-label="Khoá và phát">
              <button
                className={`btn btn-sm btn-toggle${melodyLocked ? ' is-on' : ''}`}
                onClick={() => setLock('melody', !melodyLocked)}
                aria-pressed={melodyLocked}
                title="Khoá giai điệu: máy không tạo, biến tấu hay ngân đè lên, cũng không sửa tay được"
              >
                Khoá giai điệu
              </button>
              <button
                className={`btn btn-sm btn-toggle${chordsLocked ? ' is-on' : ''}`}
                onClick={() => setLock('chords', !chordsLocked)}
                aria-pressed={chordsLocked}
                title="Khoá hợp âm: đổi cảm xúc, hoà âm, ngân nga không đổi hợp âm đang có"
              >
                Khoá hợp âm
              </button>
              <button
                className={`btn btn-sm btn-toggle${loopOn ? ' is-on' : ''}`}
                onClick={() => {
                  if (!loopRange) setLoop(defaultLoop())
                  setLoopOn(!loopOn)
                }}
                aria-pressed={loopOn}
                title="Lặp một đoạn (phím L). Kéo trên thước ô nhịp để chọn đoạn lặp"
              >
                {loopOn && loopRange ? `Lặp ô ${loopRange.start / STEPS_PER_BAR + 1}–${loopRange.end / STEPS_PER_BAR}` : 'Lặp'}
              </button>
              <button
                className={`btn btn-sm btn-toggle${metronome ? ' is-on' : ''}`}
                onClick={() => setMetronome(!metronome)}
                aria-pressed={metronome}
                title="Tiếng gõ mỗi phách khi phát. Không có trong file xuất"
              >
                Đếm nhịp
              </button>
            </div>
            <div className="tool-group" role="group" aria-label="Chỉnh lưới">
              <button
                className={`btn btn-sm btn-toggle${lockScale ? ' is-on' : ''}`}
                onClick={toggleLock}
                aria-pressed={lockScale}
                title={lockScale ? 'Chỉ hiện nốt trong thang âm, không thể bấm sai' : 'Đang hiện đủ 12 nốt'}
              >
                Khoá thang âm
              </button>
              <label className="field-inline">
                <span>Nốt mới</span>
                <select value={grid} onChange={(e) => setGrid(Number(e.target.value))}>
                  <option value={4}>Đen (1 phách)</option>
                  <option value={2}>Móc đơn (½ phách)</option>
                  <option value={1}>Móc kép (¼ phách)</option>
                </select>
              </label>
              <button className="btn btn-sm btn-quiet" onClick={trimEnd} disabled={contentEnd >= song.bars} title="Bỏ các ô không có nốt ở cuối bài">
                Bỏ ô trống cuối bài
              </button>
              <div className="seg" role="group" aria-label="Thu phóng timeline">
                <button onClick={() => setZoom(Math.max(0, zoom - 1))} disabled={zoom === 0}>
                  Thu nhỏ
                </button>
                <button onClick={() => setZoom(Math.min(ZOOMS.length - 1, zoom + 1))} disabled={zoom === ZOOMS.length - 1}>
                  Phóng to
                </button>
              </div>
            </div>
          </div>

          <Timeline
            song={song}
            stepW={stepW}
            lockScale={lockScale}
            grid={grid}
            syllables={syllables}
            hintIds={hintIds}
            selectedBar={selectedBar}
            fxSelected={fxSelected}
            customFx={customFx}
            cursor={cursor}
            onSelectBar={(bar) => {
              setSelectedBar(bar === selectedBar ? null : bar)
              void previewChord(song.chords[bar])
            }}
            onMelody={setMelody}
            onFx={setFx}
            onSeek={seek}
            onPreview={(p) => void previewNote(p)}
            onPreviewFx={(id) => void previewFx(id)}
            gridRef={gridRef}
            scrollRef={scrollRef}
            selected={selectedIds}
            onSelect={(ids) => setSelected(new Set(ids))}
            melodyLocked={melodyLocked}
            loop={loopRange}
            loopOn={loopOn}
            onLoop={(r) => {
              setLoop(r)
              setLoopOn(true)
            }}
          />

          <ChordInspector
            song={song}
            bar={selectedBar}
            onSetChord={(bar, c) => update((s) => ({ ...s, chords: s.chords.map((x, i) => (i === bar ? c : x)) }))}
            onPreviewChord={(c) => void previewChord(c)}
            onNextProgression={nextProgression}
            onHarmonize={() => update((s) => ({ ...s, chords: harmonize(s) }))}
            onToggleSevenths={toggleSevenths}
            onClose={() => setSelectedBar(null)}
            locked={chordsLocked}
          />
          <p className="foot">
            Bấm vào lưới để thêm nốt, kéo để di chuyển, kéo mép phải để kéo dài, chuột phải để xoá. Giữ Shift để bấm hoặc kéo khung chọn nhiều nốt.
            Bấm thước ô nhịp để chọn chỗ phát, kéo trên thước để đặt vùng lặp. Phím tắt: Space phát/dừng, Home về đầu, L lặp, Ctrl+Z hoàn tác,
            Ctrl+C / Ctrl+V chép, dán tại chỗ phát, Ctrl+D nhân đôi, Delete xoá, Ctrl+A chọn hết. Bài được tự lưu trong trình duyệt.
          </p>
        </section>
      </div>

      {cloudOpen && (
        <CloudList currentId={cloudId} onOpen={(id) => void openCloud(id)} onDeleted={(id) => id === cloudId && setCloudId(null)} onClose={() => setCloudOpen(false)} />
      )}

      {message && (
        <div className="toast" role="status">
          {message}
        </div>
      )}
    </div>
  )
}
