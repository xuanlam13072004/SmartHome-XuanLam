import { useCallback, useEffect, useState } from 'react'
import { cancelAdminPayment, confirmAdminPayment, fetchAdminPayments } from '../../api'
import type { AdminOrder, AdminPayments, AdminPaymentTab, AdminTransfer } from '../../types'
import { EmptyState } from '../EmptyState'
import { formatDate, formatNumber, readError } from '../format'
import { Pager } from '../registry/Pager'
import { formatVnd, orderStatusLabel, paidViaLabel, transferOutcomeLabel } from './adminFormat'
import { ReasonDialog } from './ReasonDialog'

const TABS: Array<{ id: AdminPaymentTab; label: string }> = [
  { id: 'review', label: 'Thiếu tiền' },
  { id: 'pending', label: 'Đang chờ (7 ngày)' },
  { id: 'paid', label: 'Đã trả' },
  { id: 'unmatched', label: 'Tiền chưa khớp (30 ngày)' },
]

type Pending = { kind: 'confirm' | 'cancel'; order: AdminOrder } | null

/** "Thanh toán": orders to look at and transfers no order matched, with the two corrections. */
export function PaymentsTab({ onOpenAccount }: { onOpenAccount: (account: { id: string; email: string }) => void }) {
  const [tab, setTab] = useState<AdminPaymentTab>('review')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<AdminPayments | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState<Pending>(null)
  const [amount, setAmount] = useState('')

  const load = useCallback(async () => {
    try {
      setData(await fetchAdminPayments(tab, page))
      setError('')
    } catch (caught) {
      setError(readError(caught, 'Không tải được thanh toán.'))
    }
  }, [page, tab])

  useEffect(() => {
    void load()
  }, [load])

  const open = (kind: 'confirm' | 'cancel', order: AdminOrder) => {
    setAmount(String(order.amount_vnd - order.received_vnd))
    setNotice('')
    setPending({ kind, order })
  }

  const counts = data?.counts
  const amountValue = Number(amount)
  return (
    <div className="admin-payments">
      <div className="admin-payments__summary">
        <div className="segment-control" role="tablist" aria-label="Loại thanh toán">
          {TABS.map((item) => {
            const count = item.id === 'paid' ? null : counts?.[item.id]
            return (
              <button
                aria-pressed={tab === item.id}
                className="segment-control__option"
                key={item.id}
                onClick={() => { setTab(item.id); setPage(1); setData(null) }}
                type="button"
              >
                {item.label}{count ? ` · ${formatNumber(count)}` : ''}
              </button>
            )
          })}
        </div>
        {data && (
          <p className="admin-inline-facts">
            {data.mode === 'mock' ? 'Chế độ thử (tiền không thật)' : data.mode === 'bank' ? 'Chuyển khoản VietQR' : 'Thanh toán đang tắt'}
            {' · '}SePay tháng này {formatNumber(data.sepay.used)} / {formatNumber(data.sepay.limit)} giao dịch
          </p>
        )}
      </div>
      {error && <p className="notice notice--error" role="alert">{error}</p>}
      {notice && <p className="notice notice--success" role="status">{notice}</p>}

      {!data ? (
        <div className="registry-skeleton" aria-label="Đang tải thanh toán"><span /><span /></div>
      ) : data.items.length === 0 ? (
        <EmptyState description="Không có mục nào trong nhóm này." title="Trống." />
      ) : tab === 'unmatched' ? (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Nhận lúc</th>
              <th scope="col">Số tiền</th>
              <th scope="col">Nội dung chuyển khoản</th>
              <th scope="col">Kết quả</th>
              <th scope="col">Mã tham chiếu</th>
            </tr>
          </thead>
          <tbody>
            {(data.items as AdminTransfer[]).map((transfer) => (
              <tr key={transfer.id}>
                <td className="cell-muted">{formatDate(transfer.transferred_at ?? transfer.received_at)}</td>
                <td>{formatVnd(transfer.amount_vnd)}</td>
                <td><code>{transfer.content || '—'}</code></td>
                <td>{transferOutcomeLabel[transfer.outcome] ?? transfer.outcome}{transfer.order_code ? ` (${transfer.order_code})` : ''}</td>
                <td className="cell-muted"><code>{transfer.provider}:{transfer.reference}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Đơn</th>
              <th scope="col">Tài khoản</th>
              <th scope="col">Đã nhận / giá</th>
              <th scope="col">Trạng thái</th>
              <th scope="col">{tab === 'paid' ? 'Trả lúc' : 'Tạo lúc'}</th>
              {tab !== 'paid' && <th scope="col"><span className="visually-hidden">Thao tác</span></th>}
            </tr>
          </thead>
          <tbody>
            {(data.items as AdminOrder[]).map((order) => (
              <tr key={order.code}>
                <td><code>{order.code}</code><small className="cell-muted"> · {order.plan.name} {order.months} tháng</small></td>
                <td>
                  {order.account && (
                    <button className="row-link" onClick={() => onOpenAccount(order.account!)} type="button">
                      <span><code>{order.account.email}</code></span>
                    </button>
                  )}
                </td>
                <td>{formatVnd(order.received_vnd)} / {formatVnd(order.amount_vnd)}</td>
                <td>{orderStatusLabel[order.status]}{order.paid_via ? ` · ${paidViaLabel[order.paid_via]}` : ''}</td>
                <td className="cell-muted">{formatDate((tab === 'paid' ? order.paid_at : order.created_at) ?? '')}</td>
                {tab !== 'paid' && (
                  <td>
                    <div className="admin-row-actions">
                      <button className="button button--compact" onClick={() => open('confirm', order)} type="button">Xác nhận tiền</button>
                      <button className="button button--quiet button--compact" onClick={() => open('cancel', order)} type="button">Hủy</button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data && data.total > 0 && <Pager onPage={setPage} page={data.page} pageSize={data.page_size} total={data.total} />}

      <ReasonDialog
        confirmLabel="Xác nhận đã nhận tiền"
        description={pending ? (
          <p>
            Chỉ xác nhận khi đã thấy tiền vào tài khoản ngân hàng. Đơn <code>{pending.order.code}</code> giá {formatVnd(pending.order.amount_vnd)},
            đã nhận {formatVnd(pending.order.received_vnd)}. Đủ tiền thì gói kích hoạt ngay và khách được báo.
          </p>
        ) : null}
        onCancel={() => setPending(null)}
        onConfirm={async (reason) => {
          if (!pending) return
          const result = await confirmAdminPayment(pending.order.code, { amount_vnd: amountValue, reason })
          setPending(null)
          setNotice(result.order.status === 'paid'
            ? `Đơn ${result.order.code} đã đủ tiền; gói ${result.order.plan.name} đã kích hoạt.`
            : `Đã ghi nhận; đơn ${result.order.code} vẫn còn thiếu ${formatVnd(result.order.amount_vnd - result.order.received_vnd)}.`)
          await load()
        }}
        open={pending?.kind === 'confirm'}
        ready={Number.isInteger(amountValue) && amountValue > 0}
        title="Xác nhận đã nhận tiền"
      >
        <label className="field">
          <span>Số tiền thực nhận (đồng)</span>
          <input inputMode="numeric" min={1} onChange={(event) => setAmount(event.target.value)} type="number" value={amount} />
        </label>
      </ReasonDialog>
      <ReasonDialog
        confirmLabel="Hủy đơn"
        danger
        description={pending ? <p>Đơn <code>{pending.order.code}</code> không nhận tiền nữa; app của khách được báo đơn đã hủy.</p> : null}
        onCancel={() => setPending(null)}
        onConfirm={async (reason) => {
          if (!pending) return
          await cancelAdminPayment(pending.order.code, reason)
          setPending(null)
          setNotice(`Đã hủy đơn ${pending.order.code}.`)
          await load()
        }}
        open={pending?.kind === 'cancel'}
        title="Hủy đơn hàng?"
      />
    </div>
  )
}
