import { useMemo, useState } from 'react'
import type { SimulatedDevice } from '../../types'
import { flattenRecord, formatValue, humanize } from './device-utils'

type DataTab = 'device' | 'telemetry' | 'shadow'

export function DeviceTelemetryPanel({
  device,
  latestTelemetry,
  backendShadow,
}: {
  device: SimulatedDevice
  latestTelemetry: Record<string, unknown> | null
  backendShadow: Record<string, unknown> | null
}) {
  const [tab, setTab] = useState<DataTab>('telemetry')
  const source = tab === 'device'
    ? device.state_snapshot || null
    : tab === 'telemetry'
      ? latestTelemetry
      : backendShadow
  const rows = useMemo(() => flattenRecord(source).slice(0, 120), [source])

  return (
    <section className="telemetry-panel" aria-labelledby="telemetry-title">
      <header className="work-panel__heading">
        <div>
          <h3 id="telemetry-title">Dữ liệu qua hệ thống</h3>
          <p>So sánh bộ nhớ thiết bị, gói MQTT gần nhất và shadow phía backend.</p>
        </div>
        <time dateTime={device.last_telemetry}>
          {device.last_telemetry ? `Gửi lúc ${formatTime(device.last_telemetry)}` : 'Chưa gửi telemetry'}
        </time>
      </header>

      <div aria-label="Nguồn dữ liệu" className="data-tabs" role="tablist">
        <Tab active={tab === 'device'} label="Trong thiết bị" onClick={() => setTab('device')} />
        <Tab active={tab === 'telemetry'} label="MQTT gần nhất" onClick={() => setTab('telemetry')} />
        <Tab active={tab === 'shadow'} label="Backend shadow" onClick={() => setTab('shadow')} />
      </div>

      <div className="data-tab-panel" role="tabpanel">
        {source && rows.length > 0 ? (
          <>
            <dl className="value-list">
              {rows.map((row) => (
                <div key={row.path}>
                  <dt title={row.path}>{readablePath(row.path)}</dt>
                  <dd>{formatUnknown(row.value)}</dd>
                </div>
              ))}
            </dl>
            <details className="raw-disclosure">
              <summary>Xem JSON thô</summary>
              <pre>{JSON.stringify(source, null, 2)}</pre>
            </details>
          </>
        ) : (
          <div className="empty-state empty-state--compact">
            <strong>Chưa có dữ liệu ở nguồn này.</strong>
            <p>Kết nối thiết bị và gửi một gói telemetry để kiểm tra lại.</p>
          </div>
        )}
      </div>
    </section>
  )
}

function Tab({
  active,
  label,
  onClick,
}: {
  active: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      aria-selected={active}
      onClick={onClick}
      role="tab"
      tabIndex={active ? 0 : -1}
      type="button"
    >
      {label}
    </button>
  )
}

const readablePath = (path: string): string => path
  .split('.')
  .filter((part) => !['instances', 'reported', 'diagnostics'].includes(part))
  .map(humanize)
  .join(' · ')

const formatUnknown = (value: unknown): string => {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value)) && value.includes('T')) {
    return formatTime(value)
  }
  return formatValue(value)
}

const formatTime = (value: string): string => new Intl.DateTimeFormat('vi-VN', {
  dateStyle: 'short',
  timeStyle: 'medium',
}).format(new Date(value))
