import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchUsers, subscribeStream } from '../api'
import type { SimulatedUser } from '../types'
import { Icon } from './Icon'
import { EmptyState } from './DevicesPage'
import { humanize } from './device/device-utils'

export function UsersPage({
  enabled,
  onCreate,
  onSelectUser,
}: {
  enabled: boolean
  onCreate: () => void
  onSelectUser: (accountId: string) => void
}) {
  const [users, setUsers] = useState<SimulatedUser[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!enabled) {
      setLoading(false)
      return
    }
    try {
      setUsers(await fetchUsers())
      setError('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không tải được danh sách người dùng.')
    } finally {
      setLoading(false)
    }
  }, [enabled])

  useEffect(() => {
    void load()
    if (!enabled) return
    return subscribeStream((event) => {
      if (event.account_id || event.type.startsWith('user.')) void load()
    })
  }, [enabled, load])

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return users.filter((user) => !normalized || `${user.full_name} ${user.email} ${user.account_id || ''}`
      .toLowerCase()
      .includes(normalized))
  }, [query, users])

  if (!enabled) {
    return (
      <EmptyState
        actionLabel="Mở kiểm tra hệ thống"
        description="Xác thực admin token trước khi đọc registry người dùng."
        onAction={() => window.dispatchEvent(new CustomEvent('simulator:navigate-system'))}
        title="Simulator chưa sẵn sàng."
      />
    )
  }

  return (
    <section aria-labelledby="users-title" className="registry-page">
      <header className="page-heading">
        <div>
          <h2 id="users-title">Người dùng ảo</h2>
          <p>Tài khoản được đăng ký qua API Gateway và có thể đăng nhập trên ứng dụng Flutter.</p>
        </div>
        <button className="button button--primary" onClick={onCreate} type="button">Tạo người dùng</button>
      </header>

      <div className="registry-toolbar registry-toolbar--simple">
        <label className="search-field">
          <Icon name="search" />
          <span className="visually-hidden">Tìm người dùng</span>
          <input onChange={(event) => setQuery(event.target.value)} placeholder="Tên, email hoặc Account ID" type="search" value={query} />
        </label>
        <button className="icon-button" onClick={() => void load()} title="Tải lại danh sách" type="button"><Icon name="refresh" /><span className="visually-hidden">Tải lại</span></button>
      </div>

      {error && <p className="notice notice--error" role="alert">{error}</p>}
      {loading ? (
        <div className="registry-skeleton" aria-label="Đang tải người dùng"><span /><span /><span /></div>
      ) : filtered.length === 0 ? (
        <EmptyState
          actionLabel={users.length ? 'Xóa tìm kiếm' : 'Tạo dữ liệu mô phỏng'}
          description={users.length ? 'Không có tài khoản nào khớp từ khóa.' : 'Bạn có thể tạo một hoặc nhiều user và số thiết bị cho mỗi user.'}
          onAction={users.length ? () => setQuery('') : onCreate}
          title={users.length ? 'Không tìm thấy người dùng.' : 'Chưa có người dùng ảo.'}
        />
      ) : (
        <div className="user-list">
          {filtered.map((user) => (
            <button
              className="user-row"
              disabled={!user.account_id}
              key={`${user.run_id}:${user.generation_index}`}
              onClick={() => user.account_id && onSelectUser(user.account_id)}
              type="button"
            >
              <span className="user-row__avatar" aria-hidden="true">{initials(user.full_name)}</span>
              <span><strong>{user.full_name}</strong><small>{user.email}</small></span>
              <span><small>Thiết bị</small><strong>{user.target_device_count}</strong></span>
              <span><small>Trạng thái</small><strong>{humanize(user.status)}</strong></span>
              <span><small>Lưu trữ</small><strong>{user.retention_policy === 'permanent' ? 'Cố định' : '24 giờ'}</strong></span>
              <Icon name="arrow" />
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

const initials = (name: string): string => name
  .split(/\s+/)
  .filter(Boolean)
  .slice(-2)
  .map((part) => part[0]?.toUpperCase())
  .join('') || 'U'
