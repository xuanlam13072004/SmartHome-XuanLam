import { useCallback, useEffect, useState } from 'react'
import { fetchDevicesPage, type DeviceQuery } from '../../api'
import type { CatalogProduct, Page, SimulatedDevice, SimulationRun } from '../../types'
import { humanize } from '../device/device-utils'
import { categoryCode, formatDate, formatRelative, readError, runtimeTone } from '../format'
import { Icon } from '../Icon'
import { Pager } from './Pager'
import { SEARCH_DEBOUNCE_MS, type DeviceFilters } from './filters'

const PAGE_SIZE = 50

/** Server-paged device registry; the visible page refreshes every 5 seconds. */
export function DeviceTable({
  products,
  runs,
  filters,
  onFilters,
  onSelectDevice,
}: {
  products: CatalogProduct[]
  runs: SimulationRun[]
  filters: DeviceFilters
  onFilters: (filters: DeviceFilters) => void
  onSelectDevice: (mac: string) => void
}) {
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState(filters.q)
  const [result, setResult] = useState<Page<SimulatedDevice> | null>(null)
  const [error, setError] = useState('')
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (search !== filters.q) onFilters({ ...filters, q: search })
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [filters, onFilters, search])

  useEffect(() => setPage(1), [filters])

  const load = useCallback(async () => {
    const query: DeviceQuery = {
      page,
      pageSize: PAGE_SIZE,
      productId: filters.productId || undefined,
      status: filters.status || undefined,
      q: filters.q || undefined,
      ...(filters.runId === 'factory' ? { origin: 'factory' as const } : { runId: filters.runId || undefined }),
    }
    try {
      setResult(await fetchDevicesPage(query))
      setNow(Date.now())
      setError('')
    } catch (caught) {
      setError(readError(caught, 'Không tải được danh sách thiết bị.'))
    }
  }, [filters, page])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, 5000)
    return () => window.clearInterval(timer)
  }, [load])

  const productOf = new Map(products.map((product) => [product.id, product]))
  const set = (patch: Partial<DeviceFilters>) => onFilters({ ...filters, ...patch })

  return (
    <div className="registry">
      <div className="filter-bar">
        <label className="search-field">
          <Icon name="search" />
          <span className="visually-hidden">Tìm thiết bị</span>
          <input onChange={(event) => setSearch(event.target.value)} placeholder="Tên, MAC, serial hoặc email chủ" type="search" value={search} />
        </label>
        <select aria-label="Lần chạy" onChange={(event) => set({ runId: event.target.value })} value={filters.runId}>
          <option value="">Mọi nguồn</option>
          <option value="factory">Xưởng (thiết bị trắng)</option>
          {runs.filter((run) => run.status !== 'cleaned').map((run) => (
            <option key={run.id} value={run.id}>Lần chạy {formatDate(run.created_at)} · {run.config.user_count} người</option>
          ))}
        </select>
        <select aria-label="Sản phẩm" onChange={(event) => set({ productId: event.target.value })} value={filters.productId}>
          <option value="">Mọi sản phẩm</option>
          {products.map((product) => <option key={product.id} value={product.id}>{product.display_name}</option>)}
        </select>
        <select aria-label="Trạng thái" onChange={(event) => set({ status: event.target.value })} value={filters.status}>
          <option value="">Mọi trạng thái</option>
          <option value="online">Trực tuyến</option>
          <option value="offline">Ngoại tuyến</option>
          <option value="paused">Tạm dừng</option>
          <option value="awaiting_claim">Chờ ghép nối</option>
          <option value="error">Lỗi</option>
        </select>
      </div>

      {error && <p className="notice notice--error" role="alert">{error}</p>}
      {!result ? (
        <div className="registry-skeleton" aria-label="Đang tải thiết bị"><span /><span /><span /></div>
      ) : result.items.length === 0 ? (
        <p className="empty-inline">Không có thiết bị nào khớp bộ lọc.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Thiết bị</th>
              <th scope="col">Sản phẩm</th>
              <th scope="col">Chủ sở hữu</th>
              <th scope="col">Trạng thái</th>
              <th scope="col">Telemetry gần nhất</th>
            </tr>
          </thead>
          <tbody>
            {result.items.map((device) => {
              const product = productOf.get(device.product_id)
              return (
                <tr key={device.mac} onClick={() => onSelectDevice(device.mac)}>
                  <td>
                    <button className="row-link" onClick={(event) => { event.stopPropagation(); onSelectDevice(device.mac) }} type="button">
                      <span className="row-symbol" aria-hidden="true">{categoryCode(product?.category)}</span>
                      <span>
                        <strong>{device.name}</strong>
                        <code>{device.serial_number || device.mac}</code>
                      </span>
                    </button>
                  </td>
                  <td>{product?.display_name || device.product_id}</td>
                  <td className="cell-muted">
                    {device.origin === 'factory'
                      ? (device.provisioning_state === 'claimed' ? 'Người dùng thật' : 'Xưởng · chưa có chủ')
                      : device.owner_email || '—'}
                  </td>
                  <td>
                    <span className={`runtime-badge runtime-badge--${runtimeTone(device.runtime_state)}`}>
                      <i aria-hidden="true" />{humanize(device.runtime_state)}
                    </span>
                  </td>
                  <td className="cell-muted">{formatRelative(device.last_telemetry, now)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {result && result.total > 0 && (
        <Pager onPage={setPage} page={result.page} pageSize={result.page_size} total={result.total} />
      )}
    </div>
  )
}
