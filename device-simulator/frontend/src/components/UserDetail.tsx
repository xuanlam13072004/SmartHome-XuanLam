import { useCallback, useEffect, useState } from 'react'
import {
  extendUser,
  fetchUser,
  revealUserCredential,
  userAction,
} from '../api'
import type {
  DeviceOperation,
  SimulatedDevice,
  SimulatedUser,
} from '../types'
import { CopyButton } from './CopyButton'
import { Icon } from './Icon'
import { StatusBadge } from './RunsList'

export function UserDetail({
  accountId,
  onBack,
  onSelectDevice,
}: {
  accountId: string
  onBack: () => void
  onSelectDevice: (mac: string) => void
}) {
  const [user, setUser] = useState<SimulatedUser | null>(null)
  const [devices, setDevices] = useState<SimulatedDevice[]>([])
  const [telemetry, setTelemetry] = useState<Record<string, unknown>[]>([])
  const [operations, setOperations] = useState<DeviceOperation[]>([])
  const [credential, setCredential] = useState<{ email: string; password: string } | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [acting, setActing] = useState('')

  const load = useCallback(async () => {
    try {
      const result = await fetchUser(accountId)
      setUser(result.user)
      setDevices(result.devices)
      setTelemetry(result.telemetry)
      setOperations(result.operations)
      setError('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không thể tải người dùng mô phỏng')
    } finally {
      setLoading(false)
    }
  }, [accountId])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  const reveal = async () => {
    try {
      const result = await revealUserCredential(accountId)
      setCredential(result.credential)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không thể giải mã thông tin đăng nhập')
    }
  }

  const act = async (
    action: 'relogin' | 'refresh-session' | 'make-permanent',
  ) => {
    setActing(action)
    try {
      await userAction(accountId, action)
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không thể thực hiện thao tác người dùng')
    } finally {
      setActing('')
    }
  }

  const extend = async () => {
    setActing('extend')
    try {
      await extendUser(accountId, 24)
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không thể gia hạn dữ liệu')
    } finally {
      setActing('')
    }
  }

  const cleanup = async () => {
    if (!window.confirm('Xóa người dùng mô phỏng này cùng tài khoản, thiết bị và telemetry?')) return
    setActing('cleanup')
    try {
      await userAction(accountId, 'cleanup')
      onBack()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không thể dọn người dùng mô phỏng')
      setActing('')
    }
  }

  return (
    <section aria-labelledby="user-title">
      <DetailHeading id="user-title" label="Quay lại" onBack={onBack} title={user?.full_name || 'Người dùng mô phỏng'} />
      {error && <p className="notice notice--error" role="alert">{error}</p>}
      {loading && <div className="skeleton-list" />}
      {user && (
        <>
          <div className="device-toolbar">
            <button className="button button--quiet" disabled={Boolean(acting)} onClick={() => void act('relogin')} type="button">Đăng nhập lại</button>
            <button className="button button--quiet" disabled={Boolean(acting) || !user.auth_session} onClick={() => void act('refresh-session')} type="button">Làm mới phiên</button>
            <button className="button button--quiet" disabled={Boolean(acting)} onClick={() => void extend()} type="button">Gia hạn 24 giờ</button>
            {user.retention_policy !== 'permanent' && (
              <button className="button button--quiet" disabled={Boolean(acting)} onClick={() => void act('make-permanent')} type="button">Lưu vĩnh viễn</button>
            )}
            <button className="button button--danger" disabled={Boolean(acting)} onClick={() => void cleanup()} type="button">Dọn người dùng</button>
          </div>

          <dl className="detail-spec">
            <Spec label="ID tài khoản" value={user.account_id || 'Đang chờ đăng ký'} mono />
            <Spec label="Email" value={user.email} />
            <Spec label="Trạng thái tạo" value={user.generation_state} />
            <Spec
              label="Nguồn tài khoản"
              value={user.account_created_by_simulator
                ? `Đã xác minh (${formatProvenance(user.account_provenance)})`
                : 'Chưa xác minh — không được phép tự dọn'}
            />
            <Spec label="Lưu giữ" value={user.retention_policy === 'ttl' ? `Đến ${formatDate(user.expires_at)}` : 'Vĩnh viễn'} />
            <Spec label="Phiên đăng nhập" value={user.auth_session ? `${user.auth_session.session_id} · ${formatDate(user.auth_session.updated_at)}` : 'Chưa lưu'} mono />
            <Spec label="Số thiết bị mục tiêu" value={String(user.target_device_count)} />
          </dl>

          <section className="credential-panel" aria-labelledby="credential-title">
            <div>
              <h3 id="credential-title">Tài khoản đăng nhập Flutter</h3>
              <p>Mật khẩu chỉ được giải mã khi quản trị viên chủ động yêu cầu; mỗi lần xem đều được ghi vào nhật ký.</p>
            </div>
            {credential
              ? (
                <dl className="secret-sheet">
                  <div><dt>Email</dt><dd>{credential.email}<CopyButton value={credential.email} /></dd></div>
                  <div><dt>Mật khẩu</dt><dd><code>{credential.password}</code><CopyButton value={credential.password} /></dd></div>
                </dl>
              )
              : <button className="button button--quiet" onClick={() => void reveal()} type="button">Hiện thông tin đăng nhập</button>}
          </section>

          <section className="detail-section">
            <div className="section-heading section-heading--compact">
              <div><h3>Thiết bị sở hữu</h3><p>{devices.length} thiết bị đang được registry quản lý.</p></div>
            </div>
            <div className="entity-list entity-list--full">
              {devices.map((device) => (
                <button className="entity-row" key={device.mac} onClick={() => onSelectDevice(device.mac)} type="button">
                  <Icon name="device" />
                  <span><strong>{device.name}</strong><small>{device.mac} · {device.product_id}</small></span>
                  <StatusBadge status={device.runtime_state} />
                </button>
              ))}
            </div>
          </section>

          <div className="device-data-grid">
            <HistoryPanel title="Telemetry gần nhất" count={telemetry.length} value={telemetry[0]} />
            <HistoryPanel title="Thao tác gần nhất" count={operations.length} value={operations[0]} />
          </div>
        </>
      )}
    </section>
  )
}

function HistoryPanel({
  title,
  count,
  value,
}: {
  title: string
  count: number
  value?: Record<string, unknown> | DeviceOperation
}) {
  return (
    <section className="data-panel">
      <div className="section-heading section-heading--compact"><div><h3>{title}</h3><p>Đã tải {count} bản ghi.</p></div></div>
      {value
        ? <pre>{JSON.stringify(value, null, 2)}</pre>
        : <p className="empty-inline">Chưa có lịch sử phù hợp.</p>}
    </section>
  )
}

export function DetailHeading({
  id,
  label,
  onBack,
  title,
}: {
  id: string
  label: string
  onBack: () => void
  title: string
}) {
  return (
    <header className="detail-heading">
      <button className="button button--quiet" onClick={onBack} type="button">
        <span className="icon-rotate"><Icon name="arrow" /></span>
        {label}
      </button>
      <h2 id={id}>{title}</h2>
    </header>
  )
}

function Spec({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div><dt>{label}</dt><dd className={mono ? 'mono' : undefined}>{value}</dd></div>
}

const formatDate = (value?: string) => value
  ? new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  : 'Phiên chưa hoàn tất'

const formatProvenance = (value?: SimulatedUser['account_provenance']) => {
  if (value === 'recovered_after_register') return 'khôi phục sau đăng ký'
  return 'do simulator đăng ký'
}
