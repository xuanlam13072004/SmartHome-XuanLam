import { useCallback, useEffect, useState } from 'react'
import { fetchRunMetrics } from '../api'
import type { RunMetrics } from '../types'

export function RunMetricsPanel({ runId }: { runId: string }) {
  const [metrics, setMetrics] = useState<RunMetrics | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      setMetrics(await fetchRunMetrics(runId))
      setError('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không thể tải chỉ số phiên')
    }
  }, [runId])

  useEffect(() => {
    void load()
    const interval = window.setInterval(() => void load(), 2000)
    return () => window.clearInterval(interval)
  }, [load])

  if (error) return <p className="notice notice--error" role="alert">{error}</p>
  if (!metrics) return <div className="metrics-panel is-loading" aria-label="Đang tải chỉ số phiên" />

  return (
    <section className="metrics-panel" aria-labelledby={`metrics-${runId}`}>
      <header>
        <div>
          <h3 id={`metrics-${runId}`}>Tải thời gian thực</h3>
          <p>Cửa sổ {metrics.rates.window_seconds} giây · lấy mẫu lúc {formatTime(metrics.sampled_at)}</p>
        </div>
        <span className={`metrics-health${metrics.rates.telemetry_failures_per_minute > 0 ? ' metrics-health--warning' : ''}`}>
          {metrics.rates.telemetry_failures_per_minute > 0 ? 'Có lỗi truyền' : 'Ổn định'}
        </span>
      </header>
      <div className="metrics-grid" aria-live="polite">
        <Metric label="Tốc độ telemetry" value={`${formatRate(metrics.rates.telemetry_per_second)} bản tin/s`} />
        <Metric label="Lỗi" value={`${formatRate(metrics.rates.telemetry_failures_per_minute)}/phút`} />
        <Metric label="Thiết bị trực tuyến" value={`${formatInteger(metrics.runtime.connected)} / ${formatInteger(metrics.runtime.registered)}`} />
        <Metric label="Kết nối broker" value={formatInteger(metrics.runtime.broker_connected)} />
        <Metric label="Node qua Hub" value={formatInteger(metrics.runtime.relay_connected)} />
        <Metric label="Kết nối trực tiếp dự phòng" value={formatInteger(metrics.runtime.direct_fallback_connected)} />
        <Metric label="Luồng đang phát" value={formatInteger(metrics.runtime.scheduler_active)} />
        <Metric label="Hàng đợi scheduler" value={formatInteger(metrics.runtime.scheduler_due)} />
        <Metric label="Đã phát" value={formatInteger(metrics.totals.telemetry_published)} />
        <Metric label="Dung lượng đã gửi" value={formatBytes(metrics.totals.telemetry_bytes)} />
        <Metric label="Thao tác" value={formatInteger(metrics.totals.operations_received)} />
      </div>
      <footer>
        <span>RSS tiến trình {formatBytes(metrics.process.rss_bytes)}</span>
        <span>Chỉ số được ghi theo đợt mỗi giây</span>
      </footer>
    </section>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>
}

const formatInteger = (value: number) => new Intl.NumberFormat('vi-VN').format(value)
const formatRate = (value: number) => new Intl.NumberFormat('vi-VN', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
}).format(value)
const formatTime = (value: string) => new Intl.DateTimeFormat('vi-VN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
}).format(new Date(value))

const formatBytes = (value: number): string => {
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`
  return `${(value / 1024 ** 3).toFixed(1)} GiB`
}
