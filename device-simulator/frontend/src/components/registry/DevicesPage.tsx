import { useEffect, useState } from 'react'
import { fetchCatalog, fetchRuns } from '../../api'
import type { CatalogProduct, SimulationRun } from '../../types'
import { EmptyState } from '../EmptyState'
import { Icon } from '../Icon'
import { DeviceTable } from './DeviceTable'
import type { DeviceFilters } from './filters'

/** Every simulated device: from load runs and from the factory. */
export function DevicesPage({
  enabled,
  filters,
  onFilters,
  onSelectDevice,
  onManufacture,
  onCreateRun,
}: {
  enabled: boolean
  filters: DeviceFilters
  onFilters: (filters: DeviceFilters) => void
  onSelectDevice: (mac: string) => void
  onManufacture: () => void
  onCreateRun: () => void
}) {
  const [products, setProducts] = useState<CatalogProduct[]>([])
  const [runs, setRuns] = useState<SimulationRun[]>([])

  useEffect(() => {
    if (!enabled) return
    void fetchCatalog().then(setProducts).catch(() => undefined)
    void fetchRuns().then(setRuns).catch(() => undefined)
  }, [enabled])

  if (!enabled) {
    return (
      <EmptyState
        actionLabel="Mở Hệ thống"
        description="Nhập admin token và chạy kiểm tra hạ tầng trước khi xem thiết bị."
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
          <p>Thiết bị của các lần chạy và thiết bị trắng từ Xưởng. Mở một thiết bị để điều khiển phần cứng ảo, xem dữ liệu và tem QR.</p>
        </div>
        <div className="page-heading__actions">
          <button className="button" onClick={onManufacture} type="button"><Icon name="factory" size={16} />Tạo thiết bị trắng</button>
          <button className="button button--primary" onClick={onCreateRun} type="button">Tạo người dùng và thiết bị</button>
        </div>
      </header>
      <DeviceTable filters={filters} onFilters={onFilters} onSelectDevice={onSelectDevice} products={products} runs={runs} />
    </section>
  )
}
