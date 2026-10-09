import { useEffect, useState } from 'react'
import { api, type ProjectSummary, type RevisionSummary } from '../api/client'

type Props = {
  currentId: string | null
  onOpen: (id: string) => void
  onDeleted: (id: string) => void
  onClose: () => void
}

const fmt = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' })

export function CloudList({ currentId, onOpen, onDeleted, onClose }: Props) {
  const [items, setItems] = useState<ProjectSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  // Lịch sử phiên bản của một bài: mỗi lần "Lưu cloud" đè lên bài cũ, bản cũ được giữ lại (tối đa 50 bản).
  const [history, setHistory] = useState<{ id: string; revs: RevisionSummary[] | null } | null>(null)

  const showHistory = (id: string) => {
    if (history?.id === id) return setHistory(null)
    setHistory({ id, revs: null })
    api
      .listRevisions(id)
      .then((revs) => setHistory((h) => (h?.id === id ? { id, revs } : h)))
      .catch((e: Error) => setError(e.message))
  }

  const restore = async (id: string, rid: string) => {
    try {
      await api.restoreRevision(id, rid)
      setHistory(null)
      onOpen(id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    api
      .listProjects()
      .then(setItems)
      .catch((e: Error) => setError(e.message))
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const remove = async (id: string) => {
    try {
      await api.deleteProject(id)
      setItems((xs) => xs?.filter((x) => x.id !== id) ?? null)
      onDeleted(id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setConfirm(null)
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Bài của tôi" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <h2>Bài của tôi trên cloud</h2>
          <button className="btn btn-quiet btn-sm" onClick={onClose}>
            Đóng
          </button>
        </div>
        <p className="hint">Bài được gắn với trình duyệt này. Xoá dữ liệu trình duyệt sẽ mất quyền truy cập các bài đã lưu.</p>
        {error && <p className="hum-error">{error}</p>}
        {!items && !error && <p>Đang tải…</p>}
        {items && !items.length && <p>Chưa có bài nào. Bấm “Lưu cloud” để lưu bài đang làm.</p>}
        {items && items.length > 0 && (
          <ul className="cloud-list">
            {items.map((p) => (
              <li key={p.id} className={p.id === currentId ? 'is-on' : ''}>
                <div className="cloud-meta">
                  <b>{p.title || 'Không tên'}</b>
                  <span className="hint">
                    Sửa lúc {fmt.format(new Date(p.updated_at))}
                    {p.id === currentId && ' · đang mở'}
                  </span>
                </div>
                {confirm === p.id ? (
                  <>
                    <button className="btn btn-danger btn-sm" onClick={() => void remove(p.id)}>
                      Xoá hẳn
                    </button>
                    <button className="btn btn-quiet btn-sm" onClick={() => setConfirm(null)}>
                      Thôi
                    </button>
                  </>
                ) : (
                  <>
                    <button className="btn btn-sm" onClick={() => onOpen(p.id)}>
                      Mở
                    </button>
                    <button className={`btn btn-sm btn-toggle${history?.id === p.id ? ' is-on' : ''}`} onClick={() => showHistory(p.id)} aria-expanded={history?.id === p.id}>
                      Phiên bản cũ
                    </button>
                    <button className="btn btn-quiet btn-sm" onClick={() => setConfirm(p.id)}>
                      Xoá
                    </button>
                  </>
                )}
                {history?.id === p.id && (
                  <div className="cloud-history">
                    {!history.revs && <p className="hint">Đang tải…</p>}
                    {history.revs && !history.revs.length && <p className="hint">Chưa có phiên bản cũ. Mỗi lần lưu đè, bản trước đó được giữ lại ở đây.</p>}
                    {history.revs && history.revs.length > 0 && (
                      <ul>
                        {history.revs.map((r) => (
                          <li key={r.id}>
                            <span>
                              {fmt.format(new Date(r.created_at))} · {r.title || 'Không tên'} · {r.bars} ô, {r.notes} nốt
                            </span>
                            <button className="btn btn-sm" onClick={() => void restore(p.id, r.id)} title="Mở lại bản này. Bản đang có cũng được giữ thành một phiên bản, nên khôi phục nhầm vẫn quay lại được">
                              Khôi phục
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
