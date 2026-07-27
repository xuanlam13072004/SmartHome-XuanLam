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
      setError(caught instanceof Error ? caught.message : 'Could not load run metrics')
    }
  }, [runId])

  useEffect(() => {
    void load()
    const interval = window.setInterval(() => void load(), 2000)
    return () => window.clearInterval(interval)
  }, [load])

  if (error) return <p className="notice notice--error" role="alert">{error}</p>
  if (!metrics) return <div className="metrics-panel is-loading" aria-label="Loading run metrics" />

  return (
    <section className="metrics-panel" aria-labelledby={`metrics-${runId}`}>
      <header>
        <div>
          <h3 id={`metrics-${runId}`}>Live workload</h3>
          <p>Rolling {metrics.rates.window_seconds}s window · sampled {formatTime(metrics.sampled_at)}</p>
        </div>
        <span className={`metrics-health${metrics.rates.telemetry_failures_per_minute > 0 ? ' metrics-health--warning' : ''}`}>
          {metrics.rates.telemetry_failures_per_minute > 0 ? 'Delivery errors' : 'Nominal'}
        </span>
      </header>
      <div className="metrics-grid" aria-live="polite">
        <Metric label="Telemetry rate" value={`${formatRate(metrics.rates.telemetry_per_second)} msg/s`} />
        <Metric label="Failures" value={`${formatRate(metrics.rates.telemetry_failures_per_minute)}/min`} />
        <Metric label="MQTT online" value={`${formatInteger(metrics.runtime.connected)} / ${formatInteger(metrics.runtime.registered)}`} />
        <Metric label="Publish slots" value={formatInteger(metrics.runtime.scheduler_active)} />
        <Metric label="Scheduler backlog" value={formatInteger(metrics.runtime.scheduler_due)} />
        <Metric label="Published" value={formatInteger(metrics.totals.telemetry_published)} />
        <Metric label="Payload sent" value={formatBytes(metrics.totals.telemetry_bytes)} />
        <Metric label="Commands" value={formatInteger(metrics.totals.commands_received)} />
      </div>
      <footer>
        <span>Process RSS {formatBytes(metrics.process.rss_bytes)}</span>
        <span>Buffered metrics flush every second</span>
      </footer>
    </section>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>
}

const formatInteger = (value: number) => new Intl.NumberFormat().format(value)
const formatRate = (value: number) => new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
}).format(value)
const formatTime = (value: string) => new Intl.DateTimeFormat(undefined, {
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
