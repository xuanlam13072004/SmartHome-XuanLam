import { useCallback, useEffect, useState } from 'react'
import { fetchAdminAudit } from '../../api'
import type { AdminAuditItem, Page } from '../../types'
import { EmptyState } from '../EmptyState'
import { formatDate, readError } from '../format'
import { Pager } from '../registry/Pager'
import { actorLabel, auditActionLabel, auditDetail } from './adminFormat'

/** "Nhật ký": every change made from this page or the CLI, newest first, with its reason. */
export function AuditTab({ onOpenAccount }: { onOpenAccount?: (account: { id: string; email: string }) => void }) {
  const [action, setAction] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<Page<AdminAuditItem> | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      setData(await fetchAdminAudit({ page, action: action || undefined }))
      setError('')
    } catch (caught) {
      setError(readError(caught, 'Không tải được nhật ký.'))
    }
  }, [action, page])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="admin-audit">
      <div className="filter-bar">
        <select aria-label="Lọc hành động" onChange={(event) => { setAction(event.target.value); setPage(1) }} value={action}>
          <option value="">Mọi hành động</option>
          {Object.entries(auditActionLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
      {error && <p className="notice notice--error" role="alert">{error}</p>}
      {!data ? (
        <div className="registry-skeleton" aria-label="Đang tải nhật ký"><span /><span /></div>
      ) : data.items.length === 0 ? (
        <EmptyState description="Các thay đổi (khóa, tặng gói, xác nhận tiền…) sẽ hiện ở đây kèm lý do." title="Chưa có thay đổi nào." />
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Thời gian</th>
              <th scope="col">Hành động</th>
              <th scope="col">Tài khoản</th>
              <th scope="col">Lý do</th>
              <th scope="col">Người làm</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((item) => (
              <tr key={item.id}>
                <td className="cell-muted">{formatDate(item.created_at)}</td>
                <td>{auditActionLabel[item.action] ?? item.action}{auditDetail(item) ? <small className="cell-muted"> · {auditDetail(item)}</small> : null}</td>
                <td>
                  {onOpenAccount && item.account?.id && item.account.email ? (
                    <button className="row-link" onClick={() => onOpenAccount({ id: item.account!.id!, email: item.account!.email! })} type="button">
                      <span><code>{item.account.email}</code></span>
                    </button>
                  ) : <code>{item.account?.email ?? '—'}</code>}
                </td>
                <td>{item.reason}</td>
                <td className="cell-muted">{actorLabel(item.actor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data && data.total > 0 && <Pager onPage={setPage} page={data.page} pageSize={data.page_size} total={data.total} />}
    </div>
  )
}
