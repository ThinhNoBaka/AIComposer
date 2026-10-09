import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, api, type HummingResult } from './api/client'
import { Player } from './audio/player'
import { renderSongToWav } from './audio/render'
import type { FxDef } from './audio/fx'
import type { LoadState } from './audio/voices'
import { MOODS, getMood, progressionToChords } from './core/moods'
import { continueMelody, generateMelody, shiftMelody, varyMelody } from './core/melody'
import { songToMidi } from './core/midi'
import { STEPS_PER_BAR, validateSong, type Note, type Song, type Track, type TrackId } from './core/song'
import { applyHumming, resizeSong, type ApplyOptions } from './core/humming'
import { harmonize } from './core/suggest'
import { chordPitches, degreeToMidi, midiToDegree, snapToScale, NOTE_NAMES, type Chord } from './core/theory'
import { useSongStore } from './state/store'
import { ChordRow } from './ui/ChordRow'
import { CloudList } from './ui/CloudList'
import { FxPanel } from './ui/FxPanel'
import { HummingPanel } from './ui/HummingPanel'
import { Mixer } from './ui/Mixer'
import { PianoRoll, ROLL_GEOMETRY } from './ui/PianoRoll'

const MODE_LABEL: Record<Song['mode'], string> = {
  major: 'trưởng',
  minor: 'thứ',
  dorian: 'Dorian',
  majorPentatonic: 'ngũ cung trưởng',
  minorPentatonic: 'ngũ cung thứ',
}

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
  const [candidates, setCandidates] = useState<{ seeds: number[]; active: number } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [customFx, setCustomFx] = useState<FxDef[]>([])
  const [serverOk, setServerOk] = useState<boolean | null>(null)
  const [cloudId, setCloudIdState] = useState<string | null>(readCloudId)
  const [cloudOpen, setCloudOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const playheadRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const update = useCallback((patch: (s: Song) => Song, coalesce?: string) => dispatch({ type: 'update', patch, coalesce }), [dispatch])
  const setMelody = useCallback((notes: Note[], coalesce?: string) => update((s) => ({ ...s, melody: notes }), coalesce), [update])
  const setField = useCallback((patch: Partial<Song>, coalesce?: string) => update((s) => ({ ...s, ...patch }), coalesce), [update])
  const setTrack = useCallback(
    (id: TrackId, patch: Partial<Track>, coalesce?: string) =>
      update((s) => ({ ...s, tracks: { ...s.tracks, [id]: { ...s.tracks[id], ...patch } } }), coalesce),
    [update],
  )

  // Đồng bộ nhạc cụ, âm lượng với bộ phát mỗi khi bài đổi.
  useEffect(() => {
    player.onStatus = () => setStatus(player.voices?.status() ?? null)
    player.sync(song)
  }, [player, song])

  // Vạch chạy trên piano roll.
  useEffect(() => {
    if (!playing) {
      if (playheadRef.current) playheadRef.current.style.display = 'none'
      return
    }
    let raf = 0
    const loop = () => {
      const pos = player.position()
      const el = playheadRef.current
      if (el && pos !== null) {
        el.style.display = 'block'
        el.style.transform = `translateX(${pos * ROLL_GEOMETRY.STEP_W}px)`
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [playing, player])

  useEffect(() => () => player.stop(), [player])

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

  const togglePlay = useCallback(async () => {
    if (player.playing) {
      player.stop()
      setPlaying(false)
    } else {
      await player.play(() => songRef.current)
      setStatus(player.voices?.status() ?? null)
      setPlaying(true)
    }
  }, [player])

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

  // ----- Giai điệu -----
  const makeCandidates = () => {
    const base = randomSeed()
    const seeds = [base, base + 1, base + 2]
    setCandidates({ seeds, active: 0 })
    update((s) => ({ ...s, seed: base, melody: generateMelody(s, { seed: base }) }), 'candidates')
    if (!player.playing) void togglePlay()
  }
  const pickCandidate = (i: number) => {
    if (!candidates) return
    setCandidates({ ...candidates, active: i })
    update((s) => ({ ...s, seed: candidates.seeds[i], melody: generateMelody(s, { seed: candidates.seeds[i] }) }), 'candidates')
  }
  const melodyEnd = song.melody.length ? Math.max(...song.melody.map((n) => n.start + n.dur)) : 0
  const canContinue = song.melody.length > 0 && Math.ceil(melodyEnd / STEPS_PER_BAR) < song.bars

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

  // ----- Xuất / lưu -----
  const exportMidi = () => {
    download(new Blob([songToMidi(song) as BlobPart], { type: 'audio/midi' }), `${safeName(song.title)}.mid`)
  }
  const exportWav = async () => {
    setBusy('Đang xuất WAV…')
    try {
      const v = player.voices
      const { blob, usedFallback } = await renderSongToWav(song, {
        loops: 2,
        customFx,
        customBuffers: v?.customBuffers,
      })
      download(blob, `${safeName(song.title)}.wav`)
      setMessage(usedFallback ? 'Đã xuất WAV. Một số nhạc cụ chưa tải được nên dùng synth dự phòng (kiểm tra kết nối mạng).' : 'Đã xuất WAV (2 vòng).')
    } catch (e) {
      setMessage(`Xuất WAV lỗi: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
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

  const previewFx = async (id: string) => {
    const v = await player.ensure()
    v.setVolumes(songRef.current)
    await v.prepareFx([id])
    v.fx(id, player.context!.currentTime + 0.02)
  }

  // ----- Ngân nga -> bài -----
  const applyHum = (r: HummingResult, opts: ApplyOptions) => {
    const { song: next, dropped } = applyHumming(songRef.current, r, opts)
    update(() => next)
    setCandidates(null)
    setMessage(
      `Đã đưa ${next.melody.length} nốt vào bài${opts.autoHarmony ? ' và chọn hợp âm theo giai điệu' : ''}.` +
        (dropped ? ` Bỏ ${dropped} nốt vượt quá 16 ô nhịp.` : '') +
        ' Bấm Hoàn tác nếu chưa ưng.',
    )
    if (!player.playing) void togglePlay()
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
      if (player.playing) {
        player.stop()
        setPlaying(false)
      }
      dispatch({ type: 'load', song: p.song })
      setCloudId(p.id)
      setCandidates(null)
      setCloudOpen(false)
      setMessage(`Đã mở “${p.title}” từ cloud.`)
    } catch (e) {
      setMessage(`Không mở được: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Phím tắt: Space phát/dừng, Ctrl+Z hoàn tác, Ctrl+Y / Ctrl+Shift+Z làm lại.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      if (e.code === 'Space') {
        e.preventDefault()
        void togglePlay()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        dispatch({ type: e.shiftKey ? 'redo' : 'undo' })
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        dispatch({ type: 'redo' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay, dispatch])

  useEffect(() => {
    if (!message) return
    const t = setTimeout(() => setMessage(null), 6000)
    return () => clearTimeout(t)
  }, [message])

  const mood = getMood(song.moodId)

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            ♪
          </span>
          <span>AIComposer</span>
        </div>
        <input
          className="title-input"
          value={song.title}
          onChange={(e) => setField({ title: e.target.value }, 'title')}
          aria-label="Tên bài hát"
        />
        <div className="transport">
          <button className={`play${playing ? ' on' : ''}`} onClick={() => void togglePlay()} aria-label={playing ? 'Dừng' : 'Phát'}>
            {playing ? '■ Dừng' : '▶ Phát'}
          </button>
          <button className="ghost" onClick={() => dispatch({ type: 'undo' })} disabled={!history.past.length} title="Ctrl+Z">
            ↶ Hoàn tác
          </button>
          <button className="ghost" onClick={() => dispatch({ type: 'redo' })} disabled={!history.future.length} title="Ctrl+Y">
            ↷ Làm lại
          </button>
        </div>
        <div className="exports">
          <button onClick={exportMidi}>Tải MIDI</button>
          <button onClick={() => void exportWav()} disabled={!!busy}>
            {busy ?? 'Tải WAV'}
          </button>
          <button
            onClick={() => void saveCloud()}
            disabled={saving || !serverOk}
            title={serverOk ? (cloudId ? 'Cập nhật bài đã lưu trên cloud' : 'Lưu bài lên cloud') : 'Chưa kết nối máy chủ'}
          >
            {saving ? 'Đang lưu…' : '☁ Lưu cloud'}
          </button>
          <button className="ghost" onClick={() => setCloudOpen(true)} disabled={!serverOk}>
            Bài của tôi
          </button>
          <button className="ghost" onClick={saveJson} title="Tải file bài về máy">
            Lưu file
          </button>
          <button className="ghost" onClick={() => fileRef.current?.click()}>
            Mở file
          </button>
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

      {cloudOpen && (
        <CloudList
          currentId={cloudId}
          onOpen={(id) => void openCloud(id)}
          onDeleted={(id) => id === cloudId && setCloudId(null)}
          onClose={() => setCloudOpen(false)}
        />
      )}

      {message && (
        <div className="toast" role="status">
          {message}
        </div>
      )}

      <main>
        <section className="panel">
          <h2>
            <span className="num">1</span> Chọn cảm xúc
          </h2>
          <p className="sub">
            Mỗi cảm xúc chọn sẵn giọng, tempo, vòng hợp âm, nhạc cụ và nhịp trống. Đang dùng: giọng {NOTE_NAMES[song.tonic]} {MODE_LABEL[song.mode]}, {song.bpm} BPM.
          </p>
          <div className="moods">
            {MOODS.map((m) => (
              <button
                key={m.id}
                className={`mood mood-${m.id}${song.moodId === m.id ? ' on' : ''}`}
                onClick={() => {
                  dispatch({ type: 'mood', moodId: m.id })
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

        <section className="panel hum-panel">
          <h2>
            <span className="num">2</span> Ngân nga ý tưởng của bạn
          </h2>
          <p className="sub">
            Không cần biết nốt nhạc: cứ ngân “la la” hoặc “đa đa” một câu nhạc trong đầu (tối đa 60 giây). Máy sẽ nghe ra cao độ, nhịp và giọng, rồi
            biến thành giai điệu có hợp âm, bass và trống theo cảm xúc bạn chọn.
          </p>
          <HummingPanel song={song} serverOk={serverOk} projectId={cloudId ?? undefined} onApply={applyHum} />
        </section>

        <section className="panel">
          <h2>
            <span className="num">3</span> Vòng hợp âm
          </h2>
          <p className="sub">
            Bấm một ô để nghe và đổi hợp âm. Màu cho biết cảm giác: <span className="tag fn-home">Ổn định</span>{' '}
            <span className="tag fn-move">Chuyển động</span> <span className="tag fn-tension">Căng, muốn về</span>
          </p>
          <ChordRow
            song={song}
            onSetChord={(bar, c) => update((s) => ({ ...s, chords: s.chords.map((x, i) => (i === bar ? c : x)) }))}
            onPreviewChord={(c) => void previewChord(c)}
          />
          <div className="actions">
            <button onClick={nextProgression}>Đổi vòng hợp âm khác</button>
            <button onClick={() => update((s) => ({ ...s, chords: harmonize(s) }))} disabled={!song.melody.length} title={song.melody.length ? '' : 'Cần có giai điệu trước'}>
              Hợp âm theo giai điệu
            </button>
            <button
              className={song.chords[0]?.seventh ? 'toggle on' : 'toggle'}
              onClick={() => update((s) => ({ ...s, chords: s.chords.map((c) => ({ ...c, seventh: !s.chords[0]?.seventh })) }))}
              aria-pressed={song.chords[0]?.seventh}
            >
              Hợp âm màu (7)
            </button>
          </div>
        </section>

        <section className="panel">
          <h2>
            <span className="num">4</span> Giai điệu
          </h2>
          <p className="sub">
            Hàng sáng màu là <b>nốt an toàn</b> (thuộc hợp âm đang vang). Bấm vào lưới để thêm nốt, kéo để di chuyển, kéo mép phải để kéo dài, chuột phải
            hoặc bấm đúp để xoá.
          </p>
          <div className="actions">
            <button className="primary" onClick={makeCandidates}>
              ✨ Tạo giai điệu
            </button>
            {candidates && (
              <div className="seg" role="group" aria-label="Chọn phương án giai điệu">
                {candidates.seeds.map((_, i) => (
                  <button key={i} className={candidates.active === i ? 'on' : ''} onClick={() => pickCandidate(i)}>
                    Phương án {i + 1}
                  </button>
                ))}
              </div>
            )}
            <button onClick={() => update((s) => ({ ...s, melody: continueMelody(s, randomSeed()) }))} disabled={!canContinue} title={canContinue ? 'Viết tiếp phần còn trống' : 'Giai điệu đã kín bài hoặc chưa có'}>
              Viết tiếp
            </button>
            <button onClick={() => update((s) => ({ ...s, melody: varyMelody(s, randomSeed()) }))} disabled={!song.melody.length}>
              Biến tấu
            </button>
            <button onClick={() => update((s) => ({ ...s, melody: shiftMelody(s, 1) }))} disabled={!song.melody.length}>
              Cao hơn
            </button>
            <button onClick={() => update((s) => ({ ...s, melody: shiftMelody(s, -1) }))} disabled={!song.melody.length}>
              Thấp hơn
            </button>
            <button className="ghost" onClick={() => setMelody([])} disabled={!song.melody.length}>
              Xoá giai điệu
            </button>
          </div>
          <div className="actions small">
            <button className={lockScale ? 'toggle on' : 'toggle'} onClick={toggleLock} aria-pressed={lockScale}>
              {lockScale ? '🔒 Khoá thang âm (không thể sai nốt)' : '🔓 Đã mở khoá: hiện đủ 12 nốt'}
            </button>
            <label className="field inline">
              <span>Độ dài nốt mới</span>
              <select value={grid} onChange={(e) => setGrid(Number(e.target.value))}>
                <option value={4}>Đen (1 phách)</option>
                <option value={2}>Móc đơn (½ phách)</option>
                <option value={1}>Móc kép (¼ phách)</option>
              </select>
            </label>
            <label className="field inline">
              <span>Độ dài bài</span>
              <select value={song.bars} onChange={(e) => update((s) => resizeSong(s, Number(e.target.value)))}>
                {[4, 8, 12, 16].includes(song.bars) ? null : <option value={song.bars}>{song.bars} ô</option>}
                {[4, 8, 12, 16].map((b) => (
                  <option key={b} value={b}>
                    {b} ô nhịp
                  </option>
                ))}
              </select>
            </label>
            <span className="muted-text">{song.melody.length} nốt</span>
          </div>
          <PianoRoll
            song={song}
            lockScale={lockScale}
            grid={grid}
            onChange={setMelody}
            onPreview={(p) => void previewNote(p)}
            playheadRef={playheadRef}
          />
        </section>

        <section className="panel">
          <h2>
            <span className="num">5</span> Nhạc cụ và cách đệm
          </h2>
          <p className="sub">128 nhạc cụ chuẩn General MIDI và 5 bộ trống. Sample tải từ internet khi dùng lần đầu; lúc chưa tải xong app phát bằng synth dự phòng.</p>
          <Mixer song={song} status={status} onTrack={setTrack} onField={setField} onAudition={(id) => void audition(id)} />
        </section>

        <section className="panel">
          <h2>
            <span className="num">6</span> Hiệu ứng âm thanh
          </h2>
          <p className="sub">Tiếng mưa, gió, sóng biển, chim hót, vỗ tay, riser, boom… Chọn một hiệu ứng rồi bấm vào phách muốn đặt.</p>
          <FxPanel
            song={song}
            customFx={customFx}
            onPreview={(id) => void previewFx(id)}
            onChange={(fx) => update((s) => ({ ...s, fx }))}
            onVolume={(v) => setField({ fxVolume: v }, 'fxvol')}
            onUpload={uploadFx}
          />
        </section>
      </main>
      <footer className="foot">
        Đang ở cảm xúc “{mood.label}”. Phím tắt: Space phát/dừng, Ctrl+Z hoàn tác, Ctrl+Y làm lại. Bài được tự lưu trong trình duyệt.
      </footer>
    </div>
  )
}
