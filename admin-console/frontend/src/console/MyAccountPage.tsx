import { useCallback, useEffect, useState } from 'react'
import { fetchOwnSessions, fetchPermissions, revokeOtherOwnSessions } from '../api'
import { formatDate, formatRelative, readError } from '../components/format'
import type { OwnSession, PermissionInfo } from '../types'
import { useConsole } from './ConsoleContext'
import { PasswordForm } from './PasswordForm'

/** "Tài khoản của tôi": who I am, what I may do, my password and the browsers I am signed in on. */
export function MyAccountPage() {
  const { staff } = useConsole()
  const [sessions, setSessions] = useState<OwnSession[]>([])
  const [catalog, setCatalog] = useState<PermissionInfo[]>([])
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      setSessions(await fetchOwnSessions())
      setError('')
    } catch (caught) {
      setError(readError(caught, 'Không tải được phiên đăng nhập.'))
    }
  }, [])

  useEffect(() => {
    void load()
    if (!staff.is_root) fetchPermissions().then((result) => setCatalog(result.permissions)).catch(() => undefined)
  }, [load, staff.is_root])

  const mine = catalog.filter((item) => staff.permissions.includes(item.code))
  const groups = [...new Set(mine.map((item) => item.group))]
  const others = sessions.filter((session) => !session.current).length

  return (
    <section aria-labelledby="me-title" className="registry-page console-page">
      <header className="page-heading">
        <div>
          <h2 id="me-title">{staff.full_name}</h2>
          <p><code>{staff.email}</code> · {staff.is_root ? 'Admin gốc: toàn quyền, quản lý nhân viên' : 'Nhân viên'}</p>
        </div>
      </header>
      {error && <p className="notice notice--error" role="alert">{error}</p>}
      {notice && <p className="notice notice--success" role="status">{notice}</p>}

      <div className="console-columns">
        <section>
          <h3 className="admin-subtitle">Quyền của tôi</h3>
          {staff.is_root ? (
            <ul className="admin-list">
              <li><span><strong>Toàn quyền</strong><small>Mọi mục trong menu, kể cả Simulator và quản lý nhân viên.</small></span></li>
            </ul>
          ) : groups.length === 0 ? <p className="empty-inline">Chưa được giao quyền nào. Liên hệ admin gốc.</p> : (
            <ul className="admin-list">
              {groups.map((group) => (
                <li key={group}>
                  <span>
                    <strong>{group}</strong>
                    <small>{mine.filter((item) => item.group === group).map((item) => item.label).join(' · ')}</small>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <h3 className="admin-subtitle console-spaced">Phiên đăng nhập</h3>
          <ul className="admin-list">
            {sessions.map((session) => (
              <li key={session.id}>
                <span>
                  <strong>{session.current ? 'Trình duyệt này' : (session.client || 'Trình duyệt khác')}</strong>
                  <small>{session.ip ?? 'không rõ địa chỉ'} · đăng nhập {formatDate(session.created_at)}</small>
                </span>
                <small>{formatRelative(session.last_used_at)}</small>
              </li>
            ))}
          </ul>
          <button
            className="button button--quiet button--compact console-spaced"
            disabled={others === 0}
            onClick={() => {
              revokeOtherOwnSessions()
                .then((result) => {
                  setNotice(`Đã đăng xuất ${result.signed_out_sessions} phiên khác.`)
                  return load()
                })
                .catch((caught) => setError(readError(caught, 'Chưa đăng xuất được các phiên khác.')))
            }}
            type="button"
          >
            Đăng xuất các phiên khác ({others})
          </button>
        </section>
        <section>
          <h3 className="admin-subtitle">Đổi mật khẩu</h3>
          <PasswordForm onChanged={() => { setNotice('Đã đổi mật khẩu; các phiên khác đã được đăng xuất.'); void load() }} />
        </section>
      </div>
    </section>
  )
}
