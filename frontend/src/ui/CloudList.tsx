import { useEffect, useState } from 'react'
import { api, type ProjectSummary } from '../api/client'

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
          <button className="ghost" onClick={onClose} aria-label="Đóng">
            ✕
          </button>
        </div>
        <p className="muted-text">Bài được gắn với trình duyệt này. Xoá dữ liệu trình duyệt sẽ mất quyền truy cập các bài đã lưu.</p>
        {error && <p className="hum-error">{error}</p>}
        {!items && !error && <p>Đang tải…</p>}
        {items && !items.length && <p>Chưa có bài nào. Bấm “☁ Lưu cloud” để lưu bài đang làm.</p>}
        {items && items.length > 0 && (
          <ul className="cloud-list">
            {items.map((p) => (
              <li key={p.id} className={p.id === currentId ? 'on' : ''}>
                <div className="cloud-meta">
                  <b>{p.title || 'Không tên'}</b>
                  <span className="muted-text">
                    Sửa lúc {fmt.format(new Date(p.updated_at))}
                    {p.id === currentId && ' · đang mở'}
                  </span>
                </div>
                {confirm === p.id ? (
                  <>
                    <button className="danger" onClick={() => void remove(p.id)}>
                      Xoá hẳn
                    </button>
                    <button className="ghost" onClick={() => setConfirm(null)}>
                      Thôi
                    </button>
                  </>
                ) : (
                  <>
                    <button onClick={() => onOpen(p.id)}>Mở</button>
                    <button className="ghost" onClick={() => setConfirm(p.id)}>
                      Xoá
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
