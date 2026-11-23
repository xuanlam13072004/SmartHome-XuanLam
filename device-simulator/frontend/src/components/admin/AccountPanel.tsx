import { useCallback, useEffect, useState } from 'react'
import { adminAccountAction, type AdminAccountAction, fetchAdminAccount, fetchAdminPlans, giftAdminPlan } from '../../api'
import type { AdminAccountDetail, AdminGiftablePlan } from '../../types'
import { formatDate, formatNumber, formatRelative, readError } from '../format'
import {
  accountStatusLabel,
  accountStatusTone,
  actorLabel,
  auditActionLabel,
  auditDetail,
  formatDateOnly,
  formatVnd,
  orderStatusLabel,
  platformLabel,
  roleLabel,
} from './adminFormat'
import { ReasonDialog } from './ReasonDialog'

type Dialog = AdminAccountAction | 'gift' | null

const GIFT_DAYS = [7, 30, 90, 365]

/**
 * One customer's account: what support needs to see (plan, devices, sessions,
 * orders, earlier actions) and the four changes staff may make. Never their
 * chats, camera, access history or secrets.
 */
export function AccountPanel({ accountId, onChanged }: { accountId: string | null; onChanged: () => void }) {
  const [detail, setDetail] = useState<AdminAccountDetail | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [dialog, setDialog] = useState<Dialog>(null)
  const [plans, setPlans] = useState<AdminGiftablePlan[]>([])
  const [giftPlan, setGiftPlan] = useState('')
  const [giftDays, setGiftDays] = useState(30)

  const load = useCallback(async (id: string) => {
    try {
      setDetail(await fetchAdminAccount(id))
      setError('')
    } catch (caught) {
      setError(readError(caught, 'Không tải được tài khoản.'))
    }
  }, [])

  useEffect(() => {
    setDetail(null)
    setNotice('')
    setError('')
    if (accountId) void load(accountId)
  }, [accountId, load])

  useEffect(() => {
    if (dialog !== 'gift' || plans.length > 0) return
    fetchAdminPlans()
      .then((items) => {
        setPlans(items)
        setGiftPlan((current) => current || items[0]?.code || '')
      })
      .catch((caught) => setError(readError(caught, 'Không tải được danh sách gói.')))
  }, [dialog, plans.length])

  if (!accountId) {
    return (
      <aside className="user-panel user-panel--empty">
        <p>Chọn một tài khoản trong danh sách để xem gói, thiết bị, phiên đăng nhập và thao tác hỗ trợ.</p>
      </aside>
    )
  }

  const done = async (message: string) => {
    setDialog(null)
    setNotice(message)
    await load(accountId)
    onChanged()
  }

  const act = (action: AdminAccountAction) => async (reason: string) => {
    const result = await adminAccountAction(accountId, action, reason)
    await done(action === 'disable'
      ? `Đã khóa tài khoản và đăng xuất ${formatNumber(result.signed_out_sessions ?? 0)} phiên.`
      : action === 'enable'
        ? 'Đã mở khóa. Khách đăng nhập lại là dùng được ngay.'
        : `Đã đăng xuất ${formatNumber(result.signed_out_sessions ?? 0)} phiên.`)
  }

  const account = detail?.account
  const smart = detail?.smart_features
  const locked = account?.status === 'disabled'
  const usage = detail ? Math.min(100, Math.round((detail.plan.used_tokens / Math.max(1, detail.plan.monthly_tokens)) * 100)) : 0

  return (
    <aside aria-labelledby="admin-account-title" className="user-panel admin-account">
      <header className="user-panel__header">
        <span className="user-panel__avatar" aria-hidden="true">{(account?.full_name || '?').trim().charAt(0).toUpperCase()}</span>
        <div>
          <h3 id="admin-account-title">{account?.full_name || 'Đang tải…'}</h3>
          <p>{account ? <code>{account.email}</code> : ' '}</p>
        </div>
        {account && (
          <span className={`runtime-badge runtime-badge--${accountStatusTone(account.status)}`}>
            <i aria-hidden="true" />{accountStatusLabel[account.status]}
          </span>
        )}
      </header>
      {error && <p className="notice notice--error" role="alert">{error}</p>}
      {notice && <p className="notice notice--success" role="status">{notice}</p>}
      {locked && (
        <p className="notice notice--warning">
          Tài khoản đang bị khóa: không đăng nhập được, kịch bản hẹn giờ và tự động hóa tạm dừng. Thiết bị vẫn điều khiển tại chỗ
          được và người được chia sẻ dùng bình thường.
        </p>
      )}

      {detail && account && smart && (
        <>
          <section className="user-panel__section">
            <h4>Gói trợ lý</h4>
            <dl className="spec-sheet spec-sheet--compact">
              <div><dt>Gói</dt><dd>{detail.plan.name}{detail.plan.expires_at ? ` · đến ${formatDateOnly(detail.plan.expires_at)}` : ''}</dd></div>
              <div><dt>Tháng này</dt><dd>{formatNumber(detail.plan.used_tokens)} / {formatNumber(detail.plan.monthly_tokens)} token ({usage}%) · {formatNumber(detail.plan.requests)} lượt</dd></div>
              <div><dt>Tạo lúc</dt><dd>{formatDate(account.created_at)}</dd></div>
              <div><dt>Mã tài khoản</dt><dd><code>{account.id}</code></dd></div>
            </dl>
          </section>

          <section className="user-panel__section">
            <h4>Tính năng thông minh{locked ? ' · đang tạm dừng' : ''}</h4>
            <p className="admin-inline-facts">
              {formatNumber(smart.scenes)} kịch bản · {formatNumber(smart.schedules)} lịch hẹn giờ · {formatNumber(smart.automations)} tự động hóa đang bật
            </p>
          </section>

          <section className="user-panel__section">
            <h4>Thiết bị · {detail.devices.filter((device) => device.online).length}/{detail.devices.length} trực tuyến</h4>
            {detail.devices.length === 0 ? <p className="empty-inline">Chưa có thiết bị.</p> : (
              <ul className="admin-list">
                {detail.devices.map((device) => (
                  <li key={device.mac}>
                    <span>
                      <strong>{device.name}</strong>
                      <small>{device.product} · {roleLabel(device.role)} · <code>{device.mac}</code></small>
                    </span>
                    <span className={`runtime-badge runtime-badge--${device.online ? 'online' : 'offline'}`}>
                      <i aria-hidden="true" />{device.online ? 'Trực tuyến' : 'Ngoại tuyến'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="user-panel__section">
            <h4>Phiên đăng nhập · {detail.sessions.length}</h4>
            {detail.sessions.length === 0 ? <p className="empty-inline">Không có phiên nào đang mở.</p> : (
              <ul className="admin-list">
                {detail.sessions.map((session) => (
                  <li key={session.id}>
                    <span>
                      <strong>{session.name || platformLabel(session.platform)}</strong>
                      <small>{platformLabel(session.platform)} · đăng nhập {formatDate(session.created_at)}</small>
                    </span>
                    <small>{formatRelative(session.last_used_at)}</small>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="user-panel__section">
            <h4>Đơn hàng gần đây</h4>
            {detail.orders.length === 0 ? <p className="empty-inline">Chưa mua gói nào.</p> : (
              <ul className="admin-list">
                {detail.orders.map((order) => (
                  <li key={order.code}>
                    <span>
                      <strong><code>{order.code}</code> · {order.plan.name} {order.months} tháng</strong>
                      <small>{order.created_at ? formatDate(order.created_at) : ''} · {formatVnd(order.received_vnd)} / {formatVnd(order.amount_vnd)}</small>
                    </span>
                    <small>{orderStatusLabel[order.status]}</small>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="user-panel__section">
            <h4>Nhật ký quản trị</h4>
            {detail.admin_log.length === 0 ? <p className="empty-inline">Chưa có thay đổi nào.</p> : (
              <ul className="admin-list">
                {detail.admin_log.map((item) => (
                  <li key={item.id}>
                    <span>
                      <strong>{auditActionLabel[item.action] ?? item.action}{auditDetail(item) ? ` · ${auditDetail(item)}` : ''}</strong>
                      <small>“{item.reason}” · {actorLabel(item.actor)}</small>
                    </span>
                    <small>{formatDate(item.created_at)}</small>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="user-panel__actions">
            <button className="button button--compact" onClick={() => setDialog('gift')} type="button">Tặng/gia hạn gói</button>
            <button className="button button--quiet button--compact" disabled={detail.sessions.length === 0} onClick={() => setDialog('sign-out')} type="button">
              Đăng xuất mọi thiết bị
            </button>
            {locked ? (
              <button className="button button--primary button--compact" onClick={() => setDialog('enable')} type="button">Mở khóa</button>
            ) : account.status === 'active' ? (
              <button className="button button--quiet button--compact user-panel__danger" onClick={() => setDialog('disable')} type="button">Khóa tài khoản</button>
            ) : null}
          </div>

          <ReasonDialog
            confirmLabel="Khóa tài khoản"
            danger
            description={(
              <ul className="admin-dialog__effects">
                <li><code>{account.email}</code></li>
                <li>Mọi phiên đăng nhập ({formatNumber(detail.sessions.length)}) kết thúc ngay, app đang mở bị đăng xuất.</li>
                <li>Khách đăng nhập lại sẽ thấy “Tài khoản đã bị khóa”.</li>
                <li>{formatNumber(smart.schedules)} lịch hẹn giờ và {formatNumber(smart.automations)} tự động hóa tạm dừng.</li>
                <li>Thiết bị vẫn điều khiển tại chỗ được; người được chia sẻ dùng bình thường.</li>
              </ul>
            )}
            onCancel={() => setDialog(null)}
            onConfirm={act('disable')}
            open={dialog === 'disable'}
            title="Khóa tài khoản?"
          />
          <ReasonDialog
            confirmLabel="Mở khóa"
            description={<p><code>{account.email}</code>: khách đăng nhập lại là dùng được ngay; lịch hẹn giờ và tự động hóa chạy lại từ lần kế tiếp (không chạy bù).</p>}
            onCancel={() => setDialog(null)}
            onConfirm={act('enable')}
            open={dialog === 'enable'}
            title="Mở khóa tài khoản?"
          />
          <ReasonDialog
            confirmLabel="Đăng xuất mọi thiết bị"
            description={<p>Mọi điện thoại và máy tính đang đăng nhập <code>{account.email}</code> bị đăng xuất. Tài khoản không bị khóa: khách đăng nhập lại bằng mật khẩu.</p>}
            onCancel={() => setDialog(null)}
            onConfirm={act('sign-out')}
            open={dialog === 'sign-out'}
            title="Đăng xuất mọi thiết bị?"
          />
          <ReasonDialog
            confirmLabel="Tặng gói"
            description={(
              <p>
                Cho <code>{account.email}</code>. Cùng gói đang dùng thì cộng thêm từ ngày hết hạn; gói khác thì bắt đầu từ hôm nay
                và quy đổi thời gian còn lại. Không tạo đơn, không tính doanh thu; khách nhận thông báo.
              </p>
            )}
            onCancel={() => setDialog(null)}
            onConfirm={async (reason) => {
              const result = await giftAdminPlan(accountId, { plan_code: giftPlan, days: giftDays, reason })
              await done(`Đã tặng ${formatNumber(result.gift.days)} ngày gói ${result.gift.plan.name}, hiệu lực đến ${formatDateOnly(result.gift.expires_at)}.`)
            }}
            open={dialog === 'gift'}
            ready={Boolean(giftPlan) && giftDays >= 1 && giftDays <= 366}
            title="Tặng/gia hạn gói"
          >
            <div className="field-row">
              <label className="field">
                <span>Gói</span>
                <select onChange={(event) => setGiftPlan(event.target.value)} value={giftPlan}>
                  {plans.map((plan) => (
                    <option key={plan.code} value={plan.code}>{plan.name} · {formatNumber(plan.monthly_tokens)} token/tháng</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Số ngày</span>
                <input max={366} min={1} onChange={(event) => setGiftDays(Number(event.target.value))} type="number" value={giftDays} />
              </label>
            </div>
            <div className="segment-control" role="group" aria-label="Số ngày hay dùng">
              {GIFT_DAYS.map((days) => (
                <button aria-pressed={giftDays === days} className="segment-control__option" key={days} onClick={() => setGiftDays(days)} type="button">
                  {days === 365 ? '1 năm' : `${days} ngày`}
                </button>
              ))}
            </div>
          </ReasonDialog>
        </>
      )}
    </aside>
  )
}
