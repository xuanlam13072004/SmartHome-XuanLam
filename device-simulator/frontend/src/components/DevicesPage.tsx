import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchCatalog, fetchDevices, subscribeStream } from '../api'
import type { CatalogProduct, SimulatedDevice } from '../types'
import { Icon } from './Icon'
import { formatValue, humanize } from './device/device-utils'

export function DevicesPage({
  enabled,
  onCreate,
  onSelectDevice,
}: {
  enabled: boolean
  onCreate: () => void
  onSelectDevice: (mac: string) => void
}) {
  const [devices, setDevices] = useState<SimulatedDevice[]>([])
  const [products, setProducts] = useState<CatalogProduct[]>([])
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!enabled) {
      setLoading(false)
      return
    }
    try {
      const [deviceItems, productItems] = await Promise.all([fetchDevices(), fetchCatalog()])
      setDevices(deviceItems)
      setProducts(productItems)
      setError('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không tải được danh sách thiết bị.')
    } finally {
      setLoading(false)
    }
  }, [enabled])

  useEffect(() => {
    void load()
    if (!enabled) return
    const stop = subscribeStream((event) => {
      if (event.mac || event.type.startsWith('device.')) void load()
    })
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, 10000)
    return () => {
      stop()
      window.clearInterval(timer)
    }
  }, [enabled, load])

  const productMap = useMemo(() => new Map(products.map((product) => [product.id, product])), [products])
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return devices.filter((device) => {
      if (status !== 'all' && device.runtime_state !== status) return false
      const product = productMap.get(device.product_id)
      return !normalized || `${device.name} ${device.mac} ${device.product_id} ${product?.display_name || ''}`
        .toLowerCase()
        .includes(normalized)
    })
  }, [devices, productMap, query, status])

  if (!enabled) {
    return (
      <EmptyState
        actionLabel="Mở kiểm tra hệ thống"
        description="Xác thực admin token và hoàn tất preflight trước khi đọc thiết bị."
        onAction={() => window.dispatchEvent(new CustomEvent('simulator:navigate-system'))}
        title="Simulator chưa sẵn sàng."
      />
    )
  }

  return (
    <section aria-labelledby="devices-title" className="registry-page">
      <header className="page-heading">
        <div>
          <h2 id="devices-title">Thiết bị ảo</h2>
          <p>Mở một thiết bị để xem state, mô phỏng tín hiệu vật lý và kiểm tra telemetry.</p>
        </div>
        <button className="button button--primary" onClick={onCreate} type="button">Tạo thiết bị</button>
      </header>

      <div className="registry-toolbar">
        <label className="search-field">
          <Icon name="search" />
          <span className="visually-hidden">Tìm thiết bị</span>
          <input
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Tên, MAC hoặc Product ID"
            type="search"
            value={query}
          />
        </label>
        <label className="filter-field">
          <span>Trạng thái</span>
          <select onChange={(event) => setStatus(event.target.value)} value={status}>
            <option value="all">Tất cả</option>
            <option value="online">Trực tuyến</option>
            <option value="offline">Ngoại tuyến</option>
            <option value="paused">Tạm dừng</option>
          </select>
        </label>
        <button className="icon-button" onClick={() => void load()} title="Tải lại danh sách" type="button">
          <Icon name="refresh" />
          <span className="visually-hidden">Tải lại</span>
        </button>
      </div>

      {error && <p className="notice notice--error" role="alert">{error}</p>}
      {loading ? (
        <div className="registry-skeleton" aria-label="Đang tải thiết bị"><span /><span /><span /></div>
      ) : filtered.length === 0 ? (
        <EmptyState
          actionLabel={devices.length ? 'Xóa bộ lọc' : 'Tạo dữ liệu mô phỏng'}
          description={devices.length ? 'Không có thiết bị nào khớp từ khóa hoặc trạng thái đã chọn.' : 'Một simulation run sẽ tạo user, provision và claim thiết bị tự động.'}
          onAction={devices.length ? () => { setQuery(''); setStatus('all') } : onCreate}
          title={devices.length ? 'Không tìm thấy thiết bị.' : 'Chưa có thiết bị ảo.'}
        />
      ) : (
        <div className="device-list">
          {filtered.map((device) => {
            const product = productMap.get(device.product_id)
            const highlights = stateHighlights(device)
            return (
              <button
                className="device-row"
                key={device.mac}
                onClick={() => onSelectDevice(device.mac)}
                type="button"
              >
                <span className="device-row__symbol" aria-hidden="true">{categoryCode(product?.category)}</span>
                <span className="device-row__identity">
                  <strong>{device.name}</strong>
                  <small>{product?.display_name || device.product_id}</small>
                  <code>{device.mac}</code>
                </span>
                <span className="device-row__values">
                  {highlights.map((item) => (
                    <span key={item.label}><small>{item.label}</small><strong>{item.value}</strong></span>
                  ))}
                </span>
                <span className={`runtime-badge runtime-badge--${device.runtime_state === 'online' ? 'online' : device.runtime_state === 'paused' ? 'paused' : ['contract_error', 'mqtt_error'].includes(device.runtime_state) ? 'error' : 'offline'}`}>
                  <i aria-hidden="true" />{humanize(device.runtime_state)}
                </span>
                <Icon name="arrow" />
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}

export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
}: {
  title: string
  description: string
  actionLabel: string
  onAction: () => void
}) {
  return (
    <div className="empty-state">
      <span aria-hidden="true">—</span>
      <strong>{title}</strong>
      <p>{description}</p>
      <button className="button button--quiet" onClick={onAction} type="button">{actionLabel}</button>
    </div>
  )
}

const stateHighlights = (device: SimulatedDevice): Array<{ label: string; value: string }> => {
  const values: Array<{ label: string; value: unknown }> = []
  for (const envelope of Object.values(device.state_snapshot?.instances || {})) {
    for (const [key, value] of Object.entries(envelope.reported || {})) {
      if (typeof value === 'object' || ['uptime', 'last_command_source'].includes(key)) continue
      values.push({ label: humanize(key), value })
    }
  }
  for (const diagnostic of Object.values(device.state_snapshot?.diagnostics || {})) {
    for (const [key, value] of Object.entries(diagnostic)) {
      if (typeof value === 'object' || key === 'uptime') continue
      values.push({ label: humanize(key), value })
    }
  }
  return values.slice(0, 3).map((item) => ({ label: item.label, value: formatValue(item.value) }))
}

const categoryCode = (category?: string): string => ({
  security: 'SEC',
  environment: 'ENV',
  safety: 'SAFE',
  agriculture: 'WTR',
}[category || ''] || 'DEV')
