import type { ReactNode } from 'react'
import type { Overview } from '../../types'
import { formatBytes, formatDecimal, formatNumber } from '../format'

export interface OverviewSample {
  at: number
  telemetry: number
  connected: number
}

/** Live health of the load test: what the simulator sends and how the backend keeps up. */
export function LiveBoard({
  overview,
  history,
  error,
}: {
  overview: Overview | null
  history: OverviewSample[]
  error: string
}) {
  if (!overview) {
    return (
      <section aria-label="Số liệu trực tiếp" className="live-board live-board--loading">
        {error ? <p className="notice notice--error" role="alert">{error}</p> : <div className="registry-skeleton"><span /><span /></div>}
      </section>
    )
  }
  const { runtime, rates, process, ingest_latency: ingest, registry } = overview
  const overloaded = process.event_loop_delay_p99_ms > 200 || process.cpu_percent > 90
  const lagging = runtime.scheduler_due > Math.max(100, runtime.connected * 0.05)

  return (
    <section aria-labelledby="live-title" className="live-board">
      <header className="live-board__heading">
        <h3 id="live-title">Đang chạy</h3>
        <p>
          {formatNumber(registry.devices_total)} thiết bị · {formatNumber(registry.users_total)} người dùng trong registry
          {registry.active_runs > 0 ? ` · ${registry.active_runs} lần chạy đang hoạt động` : ''}
        </p>
      </header>

      {(overloaded || lagging) && (
        <p className="notice notice--warning" role="status">
          {overloaded
            ? 'Simulator đang quá tải (CPU hoặc event loop cao). Số liệu lúc này phản ánh giới hạn của Simulator, không phải của backend: giảm số thiết bị hoặc tăng chu kỳ telemetry.'
            : `Simulator gửi chậm hơn lịch: ${formatNumber(runtime.scheduler_due)} thiết bị đang trễ lượt gửi.`}
        </p>
      )}

      <dl className="live-grid">
        <Metric
          label="Thiết bị kết nối"
          value={formatNumber(runtime.connected)}
          unit={`/ ${formatNumber(runtime.registered)}`}
          note={[
            runtime.awaiting_claim ? `${formatNumber(runtime.awaiting_claim)} chờ ghép` : '',
            runtime.paused ? `${formatNumber(runtime.paused)} tạm dừng` : '',
          ].filter(Boolean).join(' · ') || 'Đang chạy trong Simulator'}
        />
        <Metric
          label="Telemetry"
          value={formatDecimal(rates.telemetry_per_second)}
          unit="msg/s"
          note={<Sparkline values={history.map((sample) => sample.telemetry)} />}
          wide
        />
        <Metric label="Băng thông" value={formatBytes(rates.bytes_per_second)} unit="/s" note="Payload telemetry" />
        <Metric
          label="Gửi lỗi"
          value={formatDecimal(rates.telemetry_failures_per_minute)}
          unit="/phút"
          tone={rates.telemetry_failures_per_minute > 0 ? 'error' : undefined}
          note="Telemetry không publish được"
        />
        <Metric
          label="Độ trễ ingest"
          value={ingest ? formatNumber(ingest.p50_ms) : '—'}
          unit={ingest ? 'ms' : ''}
          note={ingest ? `p95 ${formatNumber(ingest.p95_ms)} ms · ${formatNumber(ingest.samples)} mẫu / 30 s` : 'Chưa có telemetry trong 30 s'}
          tone={ingest && ingest.p95_ms > 2000 ? 'error' : undefined}
        />
        <Metric
          label="CPU Simulator"
          value={formatDecimal(process.cpu_percent)}
          unit="%"
          tone={process.cpu_percent > 90 ? 'error' : undefined}
          note={`Một lõi = 100 %`}
        />
        <Metric label="Bộ nhớ" value={formatBytes(process.rss_bytes)} note={`Heap ${formatBytes(process.heap_used_bytes)}`} />
        <Metric
          label="Event loop p99"
          value={formatDecimal(process.event_loop_delay_p99_ms)}
          unit="ms"
          tone={process.event_loop_delay_p99_ms > 200 ? 'error' : undefined}
          note="Độ trễ xử lý của Simulator"
        />
      </dl>
    </section>
  )
}

function Metric({
  label,
  value,
  unit,
  note,
  tone,
  wide,
}: {
  label: string
  value: string
  unit?: string
  note: ReactNode
  tone?: 'error'
  wide?: boolean
}) {
  return (
    <div className={`live-metric${wide ? ' live-metric--wide' : ''}${tone ? ` live-metric--${tone}` : ''}`}>
      <dt>{label}</dt>
      <dd>
        <strong>{value}</strong>
        {unit && <span>{unit}</span>}
      </dd>
      <dd className="live-metric__note">{note}</dd>
    </div>
  )
}

/** Last two minutes of a rate, drawn as a line. */
export function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <span className="sparkline sparkline--empty">Đang thu thập…</span>
  const width = 160
  const height = 32
  const max = Math.max(1, ...values)
  const step = width / (values.length - 1)
  const points = values.map((value, index) => `${(index * step).toFixed(1)},${(height - (value / max) * (height - 2) - 1).toFixed(1)}`)
  return (
    <svg aria-hidden="true" className="sparkline" preserveAspectRatio="none" viewBox={`0 0 ${width} ${height}`}>
      <polyline fill="none" points={points.join(' ')} />
    </svg>
  )
}
