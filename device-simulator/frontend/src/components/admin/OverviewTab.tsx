import { useCallback, useEffect, useState } from 'react'
import { fetchAdminOverview } from '../../api'
import type { AdminOverview } from '../../types'
import { formatNumber, readError } from '../format'
import { Icon } from '../Icon'
import { BarList, DailyColumns } from './AdminCharts'
import { formatVnd } from './adminFormat'

const REFRESH_MS = 60_000

function Metric({ label, value, note, tone }: { label: string; value: string; note: string; tone?: 'error' }) {
  return (
    <div className={`live-metric${tone ? ` live-metric--${tone}` : ''}`}>
      <dt>{label}</dt>
      <dd><strong>{value}</strong></dd>
      <dd className="live-metric__note">{note}</dd>
    </div>
  )
}

/** "Tổng quan": the whole system at a glance, refreshed every minute. */
export function OverviewTab({ onOpenPayments }: { onOpenPayments: () => void }) {
  const [data, setData] = useState<AdminOverview | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      setData(await fetchAdminOverview())
      setError('')
    } catch (caught) {
      setError(readError(caught, 'Không tải được số liệu tổng quan.'))
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [load])

  if (!data) {
    return error
      ? <p className="notice notice--error" role="alert">{error}</p>
      : <div className="registry-skeleton" aria-label="Đang tải số liệu"><span /><span /></div>
  }

  const { accounts, devices, payments, assistant, daily } = data
  const waiting = payments.review + payments.pending
  return (
    <div className="admin-overview">
      {error && <p className="notice notice--error" role="alert">{error}</p>}
      <dl className="live-grid">
        <Metric label="Tài khoản" note={`+${formatNumber(accounts.new_today)} hôm nay · +${formatNumber(accounts.new_7d)} trong 7 ngày`} value={formatNumber(accounts.total)} />
        <Metric label="Hoạt động 7 ngày" note="Có dùng app trong 7 ngày qua" value={formatNumber(accounts.active_7d)} />
        <Metric label="Đang bị khóa" note="Tính năng thông minh tạm dừng" tone={accounts.disabled > 0 ? 'error' : undefined} value={formatNumber(accounts.disabled)} />
        <Metric label="Thiết bị đã gắn" note={`${formatNumber(devices.online)} đang trực tuyến`} value={formatNumber(devices.total)} />
        <Metric
          label="Doanh thu tháng này"
          note={`${formatNumber(payments.paid_orders_month)} đơn${payments.mock_orders_month ? ` · ${formatNumber(payments.mock_orders_month)} đơn thử không tính` : ''}`}
          value={formatVnd(payments.revenue_month_vnd)}
        />
        <Metric
          label="Đơn cần xem"
          note={`${formatNumber(payments.review)} thiếu tiền · ${formatNumber(payments.unmatched_30d)} giao dịch chưa khớp`}
          tone={payments.review > 0 || payments.unmatched_30d > 0 ? 'error' : undefined}
          value={formatNumber(waiting)}
        />
        <Metric
          label="Giao dịch SePay tháng này"
          note={payments.mode === 'bank' ? 'Gói miễn phí của SePay có hạn mức' : payments.mode === 'mock' ? 'Đang ở chế độ thử, tiền không thật' : 'Thanh toán đang tắt'}
          tone={payments.sepay_used >= payments.sepay_limit - 5 ? 'error' : undefined}
          value={`${formatNumber(payments.sepay_used)} / ${formatNumber(payments.sepay_limit)}`}
        />
        <Metric
          label="Token trợ lý tháng này"
          note={`Hôm nay ${formatNumber(assistant.tokens_today)} / trần ${formatNumber(assistant.daily_cap)}`}
          value={formatNumber(assistant.tokens_month)}
        />
      </dl>
      {(payments.review > 0 || payments.unmatched_30d > 0) && (
        <p className="notice notice--warning">
          Có đơn thiếu tiền hoặc tiền chưa khớp đơn nào.{' '}
          <button className="button button--quiet button--compact" onClick={onOpenPayments} type="button">Mở Thanh toán</button>
        </p>
      )}

      <div className="admin-chart-grid">
        <DailyColumns days={daily.days} format={formatNumber} title="Tài khoản mới mỗi ngày" unit="tài khoản" values={daily.new_accounts} />
        <DailyColumns days={daily.days} format={formatVnd} title="Doanh thu mỗi ngày" values={daily.revenue_vnd} />
        <DailyColumns days={daily.days} format={formatNumber} title="Token trợ lý mỗi ngày" unit="token" values={daily.assistant_tokens} />
        <div className="admin-bars-stack">
          <BarList
            format={formatNumber}
            items={devices.by_product.map((item) => ({ key: item.product_id, label: item.name, value: item.count }))}
            title="Thiết bị theo sản phẩm"
          />
          <BarList
            format={formatNumber}
            items={data.plans.map((plan) => ({ key: plan.code, label: plan.name, value: plan.count }))}
            title="Tài khoản theo gói"
          />
        </div>
      </div>

      <p className="admin-footnote">
        <Icon name="refresh" size={14} /> Số liệu tính lúc {new Date(data.generated_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })},
        tự làm mới mỗi phút. Doanh thu không tính đơn thanh toán thử.
      </p>
    </div>
  )
}
