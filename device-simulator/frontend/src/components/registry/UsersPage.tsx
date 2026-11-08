import { useCallback, useEffect, useState } from 'react'
import { fetchCatalog, fetchRuns, fetchUsersPage } from '../../api'
import type { CatalogProduct, Page, SimulatedUser, SimulationRun } from '../../types'
import { EmptyState } from '../EmptyState'
import { formatDate, formatNumber, readError } from '../format'
import { Icon } from '../Icon'
import { Pager } from './Pager'
import { SEARCH_DEBOUNCE_MS } from './filters'
import { UserPanel } from './UserPanel'

const PAGE_SIZE = 50

/** Simulated accounts beside the selected account's login and devices. */
export function UsersPage({
  enabled,
  onSelectDevice,
  onCreateRun,
}: {
  enabled: boolean
  onSelectDevice: (mac: string) => void
  onCreateRun: () => void
}) {
  const [runs, setRuns] = useState<SimulationRun[]>([])
  const [products, setProducts] = useState<CatalogProduct[]>([])
  const [runId, setRunId] = useState('')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [result, setResult] = useState<Page<SimulatedUser> | null>(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    void fetchRuns().then(setRuns).catch(() => undefined)
    void fetchCatalog().then(setProducts).catch(() => undefined)
  }, [enabled])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(search.trim())
      setPage(1)
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [search])

  const load = useCallback(async () => {
    if (!enabled) return
    try {
      const next = await fetchUsersPage({ runId: runId || undefined, q: query || undefined, page, pageSize: PAGE_SIZE })
      setResult(next)
      setError('')
      // Something is always shown: the first account until another is chosen.
      setSelected((current) => (
        current && next.items.some((user) => user.account_id === current)
          ? current
          : next.items.find((user) => user.account_id)?.account_id || null
      ))
    } catch (caught) {
      setError(readError(caught, 'Không tải được danh sách người dùng.'))
    }
  }, [enabled, page, query, runId])

  useEffect(() => {
    void load()
  }, [load])

  if (!enabled) {
    return (
      <EmptyState
        actionLabel="Mở Hệ thống"
        description="Nhập admin token và chạy kiểm tra hạ tầng trước khi xem người dùng."
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
          <p>
            Tài khoản do Simulator đăng ký qua API Gateway. Dùng email và mật khẩu bên phải để đăng nhập app SmartHome
            và xem thiết bị của người dùng đó.
          </p>
        </div>
        <button className="button button--primary" onClick={onCreateRun} type="button">Tạo người dùng và thiết bị</button>
      </header>

      <div className="master-detail">
        <div className="registry">
          <div className="filter-bar filter-bar--two">
            <label className="search-field">
              <Icon name="search" />
              <span className="visually-hidden">Tìm người dùng</span>
              <input onChange={(event) => setSearch(event.target.value)} placeholder="Email hoặc họ tên" type="search" value={search} />
            </label>
            <select aria-label="Lần chạy" onChange={(event) => { setRunId(event.target.value); setPage(1) }} value={runId}>
              <option value="">Mọi lần chạy</option>
              {runs.filter((run) => run.status !== 'cleaned').map((run) => (
                <option key={run.id} value={run.id}>Lần chạy {formatDate(run.created_at)} · {formatNumber(run.config.user_count)} người</option>
              ))}
            </select>
          </div>
          {error && <p className="notice notice--error" role="alert">{error}</p>}
          {!result ? (
            <div className="registry-skeleton" aria-label="Đang tải người dùng"><span /><span /></div>
          ) : result.items.length === 0 ? (
            <EmptyState
              actionLabel={query || runId ? undefined : 'Tạo người dùng và thiết bị'}
              description={query || runId ? 'Không có người dùng nào khớp bộ lọc.' : 'Một lần chạy ở trang Kiểm thử tải sẽ đăng ký người dùng và thiết bị của họ.'}
              onAction={query || runId ? undefined : onCreateRun}
              title="Chưa có người dùng."
            />
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Người dùng</th>
                  <th scope="col">Thiết bị</th>
                  <th scope="col">Trạng thái</th>
                  <th scope="col">Lần chạy</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((user) => (
                  <tr
                    aria-selected={user.account_id === selected}
                    key={`${user.run_id}:${user.generation_index}`}
                    onClick={() => user.account_id && setSelected(user.account_id)}
                  >
                    <td>
                      <button className="row-link" disabled={!user.account_id} onClick={(event) => { event.stopPropagation(); if (user.account_id) setSelected(user.account_id) }} type="button">
                        <span>
                          <strong>{user.full_name}</strong>
                          <code>{user.email}</code>
                        </span>
                      </button>
                    </td>
                    <td>{formatNumber(user.claimed_device_count ?? 0)} / {formatNumber(user.target_device_count)}</td>
                    <td className={user.last_error ? 'cell-error' : 'cell-muted'}>
                      {user.last_error ? 'Lỗi khi tạo' : user.generation_state === 'ready' ? 'Sẵn sàng' : 'Đang tạo'}
                    </td>
                    <td className="cell-muted">{formatDate(runs.find((run) => run.id === user.run_id)?.created_at || user.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {result && result.total > 0 && (
            <Pager onPage={setPage} page={result.page} pageSize={result.page_size} total={result.total} />
          )}
        </div>

        <UserPanel
          accountId={selected}
          onChanged={() => {
            setSelected(null)
            void load()
          }}
          onSelectDevice={onSelectDevice}
          products={products}
        />
      </div>
    </section>
  )
}
