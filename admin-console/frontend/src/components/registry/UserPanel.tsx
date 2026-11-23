import { useEffect, useState } from 'react'
import { fetchUser, revealUserCredential, userAction } from '../../api'
import type { CatalogProduct, SimulatedDevice, SimulatedUser } from '../../types'
import { CopyButton } from '../CopyButton'
import { humanize } from '../device/device-utils'
import { categoryCode, formatDate, readError, runtimeTone } from '../format'

/**
 * Selected simulated account, always visible beside the list: the email and
 * password to sign in to the SmartHome app, its devices and its actions.
 */
export function UserPanel({
  accountId,
  products,
  onChanged,
  onSelectDevice,
}: {
  accountId: string | null
  products: CatalogProduct[]
  onChanged: () => void
  onSelectDevice: (mac: string) => void
}) {
  const productOf = new Map(products.map((product) => [product.id, product]))
  const [user, setUser] = useState<SimulatedUser | null>(null)
  const [devices, setDevices] = useState<SimulatedDevice[]>([])
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmCleanup, setConfirmCleanup] = useState(false)

  useEffect(() => {
    setUser(null)
    setDevices([])
    setPassword('')
    setError('')
    setNotice('')
    setConfirmCleanup(false)
    if (!accountId) return
    let active = true
    fetchUser(accountId)
      .then((result) => {
        if (!active) return
        setUser(result.user)
        setDevices(result.devices)
      })
      .catch((caught) => { if (active) setError(readError(caught, 'Không tải được người dùng.')) })
    return () => { active = false }
  }, [accountId])

  const run = async (key: string, action: () => Promise<void>, failure: string) => {
    setBusy(key)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (caught) {
      setError(readError(caught, failure))
    } finally {
      setBusy('')
    }
  }

  if (!accountId) {
    return (
      <aside className="user-panel user-panel--empty">
        <p>Chọn một người dùng trong danh sách để xem thông tin đăng nhập và thiết bị.</p>
      </aside>
    )
  }

  const online = devices.filter((device) => device.runtime_state === 'online').length

  return (
    <aside aria-labelledby="user-panel-title" className="user-panel">
      <header className="user-panel__header">
        <span className="user-panel__avatar" aria-hidden="true">{(user?.full_name || '?').trim().charAt(0).toUpperCase()}</span>
        <div>
          <h3 id="user-panel-title">{user?.full_name || 'Đang tải…'}</h3>
          <p>{user ? `Tạo lúc ${formatDate(user.created_at)}` : ' '}</p>
        </div>
      </header>
      {error && <p className="notice notice--error" role="alert">{error}</p>}
      {notice && <p className="notice notice--success" role="status">{notice}</p>}

      <section className="user-panel__section">
        <h4>Đăng nhập app SmartHome</h4>
        <dl className="login-card">
          <div>
            <dt>Email</dt>
            <dd><code>{user?.email || '…'}</code>{user && <CopyButton value={user.email} />}</dd>
          </div>
          <div>
            <dt>Mật khẩu</dt>
            <dd>
              {password ? (
                <><code>{password}</code><CopyButton value={password} /></>
              ) : (
                <button
                  className="button button--compact"
                  disabled={Boolean(busy)}
                  onClick={() => void run('reveal', async () => {
                    setPassword((await revealUserCredential(accountId)).credential.password)
                  }, 'Không đọc được mật khẩu.')}
                  type="button"
                >
                  {busy === 'reveal' ? 'Đang đọc…' : 'Hiện mật khẩu'}
                </button>
              )}
            </dd>
          </div>
        </dl>
      </section>

      <section className="user-panel__section">
        <h4>Tài khoản</h4>
        <dl className="spec-sheet spec-sheet--compact">
          <div><dt>Trạng thái</dt><dd>{user?.last_error ? `Lỗi khi tạo: ${user.last_error}` : user?.generation_state === 'ready' ? 'Sẵn sàng' : 'Đang tạo'}</dd></div>
          <div><dt>Phiên Simulator</dt><dd>{user?.auth_session ? `Đăng nhập lúc ${formatDate(user.auth_session.updated_at)}` : 'Chưa đăng nhập'}</dd></div>
          <div><dt>Lưu giữ</dt><dd>{user?.retention_policy === 'permanent' ? 'Giữ đến khi tự dọn' : user?.expires_at ? `Tự dọn lúc ${formatDate(user.expires_at)}` : 'Tự dọn 24 giờ sau lần chạy'}</dd></div>
          <div><dt>Mã tài khoản</dt><dd><code>{accountId}</code></dd></div>
        </dl>
      </section>

      <section className="user-panel__section">
        <h4>Thiết bị · {online}/{devices.length} trực tuyến</h4>
        {devices.length === 0 ? <p className="empty-inline">Chưa có thiết bị.</p> : (
          <ul className="user-panel__devices">
            {devices.map((device) => {
              const product = productOf.get(device.product_id)
              return (
                <li key={device.mac}>
                  <button className="row-link" onClick={() => onSelectDevice(device.mac)} type="button">
                    <span className="row-symbol" aria-hidden="true">{categoryCode(product?.category)}</span>
                    <span>
                      <strong>{device.name}</strong>
                      <small className="row-link__product">{product?.display_name || device.product_id}</small>
                      <code>{device.mac}</code>
                    </span>
                  </button>
                  <span className={`runtime-badge runtime-badge--${runtimeTone(device.runtime_state)}`}>
                    <i aria-hidden="true" />{humanize(device.runtime_state)}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <div className="user-panel__actions">
        <button
          className="button button--quiet button--compact"
          disabled={Boolean(busy)}
          onClick={() => void run('relogin', async () => {
            await userAction(accountId, 'relogin')
            setNotice('Đã đăng nhập lại; phiên mới được dùng cho các thiết bị ảo của người dùng này.')
          }, 'Không đăng nhập lại được.')}
          type="button"
        >
          {busy === 'relogin' ? 'Đang đăng nhập…' : 'Đăng nhập lại'}
        </button>
        {confirmCleanup ? (
          <>
            <button
              className="button button--danger button--compact"
              disabled={Boolean(busy)}
              onClick={() => void run('cleanup', async () => {
                await userAction(accountId, 'cleanup')
                onChanged()
              }, 'Không dọn được người dùng (lần chạy phải đã kết thúc).')}
              type="button"
            >
              Xác nhận xóa tài khoản và {devices.length} thiết bị
            </button>
            <button className="button button--quiet button--compact" onClick={() => setConfirmCleanup(false)} type="button">Thôi</button>
          </>
        ) : (
          <button className="button button--quiet button--compact user-panel__danger" disabled={Boolean(busy)} onClick={() => setConfirmCleanup(true)} type="button">
            Dọn người dùng
          </button>
        )}
      </div>
    </aside>
  )
}
