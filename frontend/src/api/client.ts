// Gọi backend AIComposer. Cùng domain khi deploy chung; khi dev, Vite chuyển /api sang localhost:8000.

import type { Mode } from '../core/theory'
import type { Song } from '../core/song'

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? ''
const KEY_STORAGE = 'aicomposer.ownerKey'

/** Khoá bí mật của trình duyệt này: bài lưu trên cloud gắn với khoá, người khác không xem được. */
export function ownerKey(): string {
  try {
    let k = localStorage.getItem(KEY_STORAGE)
    if (!k) {
      k = `${crypto.randomUUID()}-${crypto.randomUUID()}`
      localStorage.setItem(KEY_STORAGE, k)
    }
    return k
  } catch {
    // Không lưu được (chế độ ẩn danh chặn): dùng khoá tạm cho phiên này.
    const w = window as unknown as { __aicKey?: string }
    w.__aicKey ??= `${crypto.randomUUID()}-${crypto.randomUUID()}`
    return w.__aicKey
  }
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function send(path: string, init: RequestInit = {}): Promise<Response> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers: { 'X-Owner-Key': ownerKey(), ...(init.headers ?? {}) } })
  } catch {
    throw new ApiError(0, 'Không kết nối được máy chủ.')
  }
  if (!res.ok) {
    let msg = `Lỗi máy chủ (${res.status}).`
    try {
      const body = await res.json()
      if (typeof body.detail === 'string') msg = body.detail
    } catch {
      /* phản hồi không phải JSON */
    }
    throw new ApiError(res.status, msg)
  }
  return res
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await send(path, init)
  return (res.status === 204 ? undefined : await res.json()) as T
}

export type ProjectSummary = { id: string; title: string; updated_at: string }
export type ProjectFull = ProjectSummary & { song: Song; created_at: string }
export type RevisionSummary = { id: string; title: string; created_at: string; notes: number; bars: number }

export const api = {
  health: () => request<{ ok: boolean; database: string }>('/api/health'),
  listProjects: () => request<ProjectSummary[]>('/api/projects'),
  getProject: (id: string) => request<ProjectFull>(`/api/projects/${id}`),
  createProject: (song: Song) =>
    request<ProjectFull>('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: song.title, song }) }),
  updateProject: (id: string, song: Song) =>
    request<ProjectFull>(`/api/projects/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: song.title, song }) }),
  deleteProject: (id: string) => request<void>(`/api/projects/${id}`, { method: 'DELETE' }),
  listRevisions: (id: string) => request<RevisionSummary[]>(`/api/projects/${id}/revisions`),
  restoreRevision: (id: string, rid: string) => request<ProjectFull>(`/api/projects/${id}/revisions/${rid}/restore`, { method: 'POST' }),
  transcribe: (audio: Blob, filename: string, opts: { bpm?: number; tonic?: number; mode?: Mode; projectId?: string }) => {
    const fd = new FormData()
    fd.append('audio', audio, filename)
    if (opts.bpm) fd.append('bpm', String(opts.bpm))
    if (opts.tonic !== undefined && opts.mode) {
      fd.append('tonic', String(opts.tonic))
      fd.append('mode', opts.mode)
    }
    if (opts.projectId) fd.append('project_id', opts.projectId)
    return request<HummingResult>('/api/humming', { method: 'POST', body: fd })
  },
  uploadVocal: (audio: Blob, filename: string, opts: { offsetMs: number; bpm?: number; projectId?: string }) => {
    const fd = new FormData()
    fd.append('audio', audio, filename)
    fd.append('offset_ms', String(Math.round(opts.offsetMs)))
    if (opts.bpm) fd.append('bpm', String(opts.bpm))
    if (opts.projectId) fd.append('project_id', opts.projectId)
    return request<VocalTakeCreated>('/api/vocal/takes', { method: 'POST', body: fd })
  },
  listVocalTakes: (projectId?: string) => request<VocalTakeSummary[]>(`/api/vocal/takes${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`),
  correctVocal: (id: string, body: VocalCorrectRequest) =>
    request<VocalCorrectResult>(`/api/vocal/takes/${id}/correct`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  vocalAudio: async (id: string, version: 'original' | 'corrected') => (await send(`/api/vocal/takes/${id}/audio?version=${version}`)).arrayBuffer(),
  deleteVocalTake: (id: string) => request<void>(`/api/vocal/takes/${id}`, { method: 'DELETE' }),
}

export type VocalTakeCreated = { id: string; duration_s: number; sr: number; offset_ms: number; bpm: number | null; project_id: string | null }

export type VocalRecipeOut = {
  strength: number
  mode: 'melody' | 'scale' | 'chromatic'
  retune_speed_ms: number
  keep_vibrato: boolean
  key: { tonic: number; mode: string } | null
  notes_count: number
}

export type VocalTakeSummary = {
  id: string
  project_id: string | null
  created_at: string
  duration_s: number
  sr: number
  offset_ms: number
  bpm: number | null
  recipe: VocalRecipeOut | null
  has_corrected: boolean
}

export type VocalCorrectRequest = {
  strength: number
  mode: 'melody' | 'scale' | 'chromatic'
  retune_speed_ms: number
  keep_vibrato: boolean
  key?: { tonic: number; mode: Mode }
  notes?: { pitch: number; start_s: number; end_s: number }[]
}

export type VocalCorrectResult = {
  id: string
  recipe: VocalRecipeOut
  duration_s: number
  elapsed_ms: number
  f0: { hop_s: number; original: (number | null)[]; corrected: (number | null)[] }
}

export type HummingResult = {
  recording_id: string
  elapsed_ms: number
  bpm: number
  tonic: number
  mode: 'major' | 'minor' | Mode
  key_confidence: number
  bars: number
  duration_sec: number
  melody: { pitch: number; start: number; dur: number; vel: number }[]
  raw_notes: { onset: number; offset: number; pitch: number }[]
}
