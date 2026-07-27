import { useCallback, useEffect, useState } from 'react'
import {
  fetchDevice,
  revealDeviceSecret,
  sendDeviceTelemetry,
  setDeviceConnection,
} from '../api'
import type { SimulatedDevice, SimulatorEvent } from '../types'
import { CopyButton } from './CopyButton'
import { DetailHeading } from './UserDetail'
import { StatusBadge } from './RunsList'

export function DeviceDetail({
  mac,
  onBack,
}: {
  mac: string
  onBack: () => void
}) {
  const [device, setDevice] = useState<SimulatedDevice | null>(null)
  const [telemetry, setTelemetry] = useState<Record<string, unknown>[]>([])
  const [events, setEvents] = useState<SimulatorEvent[]>([])
  const [secret, setSecret] = useState('')
  const [error, setError] = useState('')
  const [acting, setActing] = useState('')

  const load = useCallback(async () => {
    try {
      const result = await fetchDevice(mac)
      setDevice(result.device)
      setTelemetry(result.telemetry)
      setEvents(result.events)
      setError('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load virtual device')
    }
  }, [mac])

  useEffect(() => {
    void load()
  }, [load])

  const setConnection = async (online: boolean) => {
    setActing(online ? 'connect' : 'disconnect')
    try {
      await setDeviceConnection(mac, online)
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not change MQTT connection')
    } finally {
      setActing('')
    }
  }

  const sendNow = async () => {
    setActing('telemetry')
    try {
      await sendDeviceTelemetry(mac)
      window.setTimeout(() => void load(), 700)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not publish telemetry')
    } finally {
      setActing('')
    }
  }

  const reveal = async () => {
    try {
      const result = await revealDeviceSecret(mac)
      setSecret(result.device.secret_key)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not reveal factory secret')
    }
  }

  const latestTelemetry = telemetry[0]

  return (
    <section aria-labelledby="device-title">
      <DetailHeading id="device-title" label="Back to runs" onBack={onBack} title={device?.name || mac} />
      {error && <p className="notice notice--error" role="alert">{error}</p>}
      {device && (
        <>
          <div className="device-toolbar">
            <StatusBadge status={device.runtime_state} />
            <button className="button button--quiet" disabled={Boolean(acting)} onClick={() => void setConnection(device.runtime_state !== 'online')} type="button">
              {device.runtime_state === 'online' ? 'Disconnect MQTT' : 'Connect MQTT'}
            </button>
            <button className="button button--primary" disabled={Boolean(acting) || device.runtime_state !== 'online'} onClick={() => void sendNow()} type="button">
              {acting === 'telemetry' ? 'Publishing…' : 'Send telemetry now'}
            </button>
          </div>

          <dl className="detail-spec">
            <Spec label="MAC address" value={device.mac} mono />
            <Spec label="Product" value={device.product_id} />
            <Spec label="Provisioning" value={device.provisioning_state} />
            <Spec label="Desired runtime" value={device.desired_state} />
            <Spec label="Sequence" value={String(device.seq)} />
            <Spec label="Last telemetry" value={formatDate(device.last_telemetry)} />
          </dl>

          <section className="credential-panel">
            <div><h3>Factory identity</h3><p>The raw secret is encrypted in the registry and never returned by list endpoints.</p></div>
            {secret
              ? <div className="secret-line"><code>{secret}</code><CopyButton value={secret} /></div>
              : <button className="button button--quiet" onClick={() => void reveal()} type="button">Reveal secret</button>}
          </section>

          <div className="device-data-grid">
            <section className="data-panel">
              <div className="section-heading section-heading--compact"><div><h3>Latest telemetry</h3><p>{telemetry.length} stored packets loaded.</p></div></div>
              {latestTelemetry
                ? <pre>{JSON.stringify(latestTelemetry, null, 2)}</pre>
                : <p className="empty-inline">No telemetry has reached SmartHomeDB yet.</p>}
            </section>
            <section className="data-panel">
              <div className="section-heading section-heading--compact"><div><h3>Recent events</h3><p>Command, runtime and security events.</p></div></div>
              <EventRows events={events} />
            </section>
          </div>
        </>
      )}
    </section>
  )
}

export function EventRows({ events }: { events: SimulatorEvent[] }) {
  if (events.length === 0) return <p className="empty-inline">No matching simulator events.</p>
  return (
    <ol className="event-list">
      {events.map((event, index) => (
        <li key={event._id || `${event.created_at}:${index}`}>
          <span className={`status-mark status-mark--${event.severity === 'error' ? 'error' : event.severity === 'warning' ? 'warning' : 'ok'}`} />
          <div><strong>{event.message}</strong><small>{formatDate(event.created_at)} · {event.type}</small></div>
        </li>
      ))}
    </ol>
  )
}

function Spec({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div><dt>{label}</dt><dd className={mono ? 'mono' : undefined}>{value}</dd></div>
}

const formatDate = (value?: string) => value
  ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value))
  : 'Not sent'
