import { useCallback, useEffect, useState } from 'react'
import { fetchAdminAccounts } from '../../api'
import type { AdminAccountFilter, AdminAccountRow, Page } from '../../types'
import { EmptyState } from '../EmptyState'
import { formatNumber, formatRelative, readError } from '../format'
import { Icon } from '../Icon'
import { Pager } from '../registry/Pager'
import { SEARCH_DEBOUNCE_MS } from '../registry/filters'
import { AccountPanel } from './AccountPanel'
import { accountStatusLabel, accountStatusTone, formatDateOnly } from './adminFormat'

/** Every account in the system (real and simulated alike), searchable by email, name or device MAC. */
export function AccountsTab({ focus }: { focus: { id: string; email: string; at: number } | null }) {
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<AdminAccountFilter>('all')
  const [page, setPage] = useState(1)
  const [result, setResult] = useState<Page<AdminAccountRow> | null>(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<string | null>(null)

  // Opened from another tab (a top user, an order): show that account.
  useEffect(() => {
    if (!focus) return
    setSearch(focus.email)
    setQuery(focus.email)
    setFilter('all')
    setPage(1)
    setSelected(focus.id)
  }, [focus])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(search.trim())
      setPage(1)
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [search])

  const load = useCallback(async () => {
    try {
      const next = await fetchAdminAccounts({ q: query || undefined, filter, page })
      setResult(next)
      setError('')
      setSelected((current) => current ?? next.items[0]?.id ?? null)
    } catch (caught) {
      setError(readError(caught, 'Không tải được danh sách tài khoản.'))
    }
  }, [filter, page, query])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="master-detail">
      <div className="registry">
        <div className="filter-bar filter-bar--two">
          <label className="search-field">
            <Icon name="search" />
            <span className="visually-hidden">Tìm tài khoản</span>
            <input onChange={(event) => setSearch(event.target.value)} placeholder="Email, họ tên hoặc MAC thiết bị" type="search" value={search} />
          </label>
          <select aria-label="Lọc tài khoản" onChange={(event) => { setFilter(event.target.value as AdminAccountFilter); setPage(1) }} value={filter}>
            <option value="all">Mọi tài khoản</option>
            <option value="paid">Có gói trả phí</option>
            <option value="disabled">Đang bị khóa</option>
          </select>
        </div>
        {error && <p className="notice notice--error" role="alert">{error}</p>}
        {!result ? (
          <div className="registry-skeleton" aria-label="Đang tải tài khoản"><span /><span /></div>
        ) : result.items.length === 0 ? (
          <EmptyState description={query || filter !== 'all' ? 'Không có tài khoản nào khớp bộ lọc.' : 'Chưa có ai đăng ký.'} title="Không có tài khoản." />
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Tài khoản</th>
                <th scope="col">Gói</th>
                <th scope="col">Thiết bị</th>
                <th scope="col">Dùng gần nhất</th>
                <th scope="col">Trạng thái</th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((account) => (
                <tr aria-selected={account.id === selected} key={account.id} onClick={() => setSelected(account.id)}>
                  <td>
                    <button className="row-link" onClick={(event) => { event.stopPropagation(); setSelected(account.id) }} type="button">
                      <span>
                        <strong>{account.full_name}</strong>
                        <code>{account.email}</code>
                      </span>
                    </button>
                  </td>
                  <td>{account.plan.name}{account.plan.expires_at ? <small className="cell-muted"> · đến {formatDateOnly(account.plan.expires_at)}</small> : null}</td>
                  <td>{formatNumber(account.owned_devices)}</td>
                  <td className="cell-muted">{account.last_seen_at ? formatRelative(account.last_seen_at) : 'Chưa đăng nhập'}</td>
                  <td>
                    <span className={`runtime-badge runtime-badge--${accountStatusTone(account.status)}`}>
                      <i aria-hidden="true" />{accountStatusLabel[account.status]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {result && result.total > 0 && (
          <Pager onPage={setPage} page={result.page} pageSize={result.page_size} total={result.total} />
        )}
      </div>
      <AccountPanel accountId={selected} onChanged={() => void load()} />
    </div>
  )
}
