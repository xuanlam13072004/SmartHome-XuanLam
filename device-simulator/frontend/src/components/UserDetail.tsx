import { useCallback, useEffect, useState } from 'react'
import {
  extendUser,
  fetchUser,
  revealUserCredential,
  userAction,
} from '../api'
import type {
  DeviceCommand,
  SimulatedDevice,
  SimulatedUser,
} from '../types'
import { CopyButton } from './CopyButton'
import { Icon } from './Icon'
import { StatusBadge } from './RunsList'

export function UserDetail({
  accountId,
  onBack,
  onSelectDevice,
}: {
  accountId: string
  onBack: () => void
  onSelectDevice: (mac: string) => void
}) {
  const [user, setUser] = useState<SimulatedUser | null>(null)
  const [devices, setDevices] = useState<SimulatedDevice[]>([])
  const [telemetry, setTelemetry] = useState<Record<string, unknown>[]>([])
  const [commands, setCommands] = useState<DeviceCommand[]>([])
  const [credential, setCredential] = useState<{ email: string; username: string; password: string } | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [acting, setActing] = useState('')

  const load = useCallback(async () => {
    try {
      const result = await fetchUser(accountId)
      setUser(result.user)
      setDevices(result.devices)
      setTelemetry(result.telemetry)
      setCommands(result.commands)
      setError('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load simulated user')
    } finally {
      setLoading(false)
    }
  }, [accountId])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  const reveal = async () => {
    try {
      const result = await revealUserCredential(accountId)
      setCredential(result.credential)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not reveal login credential')
    }
  }

  const act = async (
    action: 'relogin' | 'refresh-session' | 'make-permanent',
  ) => {
    setActing(action)
    try {
      await userAction(accountId, action)
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Could not ${action}`)
    } finally {
      setActing('')
    }
  }

  const extend = async () => {
    setActing('extend')
    try {
      await extendUser(accountId, 24)
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not extend retention')
    } finally {
      setActing('')
    }
  }

  const cleanup = async () => {
    if (!window.confirm('Delete this simulated user, their account, devices and telemetry?')) return
    setActing('cleanup')
    try {
      await userAction(accountId, 'cleanup')
      onBack()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not clean simulated user')
      setActing('')
    }
  }

  return (
    <section aria-labelledby="user-title">
      <DetailHeading id="user-title" label="Back to runs" onBack={onBack} title={user?.full_name || 'Simulated user'} />
      {error && <p className="notice notice--error" role="alert">{error}</p>}
      {loading && <div className="skeleton-list" />}
      {user && (
        <>
          <div className="device-toolbar">
            <button className="button button--quiet" disabled={Boolean(acting)} onClick={() => void act('relogin')} type="button">Login again</button>
            <button className="button button--quiet" disabled={Boolean(acting) || !user.auth_session} onClick={() => void act('refresh-session')} type="button">Refresh session</button>
            <button className="button button--quiet" disabled={Boolean(acting)} onClick={() => void extend()} type="button">Extend 24 h</button>
            {user.retention_policy !== 'permanent' && (
              <button className="button button--quiet" disabled={Boolean(acting)} onClick={() => void act('make-permanent')} type="button">Keep permanently</button>
            )}
            <button className="button button--danger" disabled={Boolean(acting)} onClick={() => void cleanup()} type="button">Cleanup user</button>
          </div>

          <dl className="detail-spec">
            <Spec label="Account ID" value={user.account_id || 'Registration pending'} mono />
            <Spec label="Email" value={user.email} />
            <Spec label="Username" value={user.username} />
            <Spec label="Generation" value={user.generation_state} />
            <Spec
              label="Account ownership"
              value={user.account_created_by_simulator
                ? `Verified (${formatProvenance(user.account_provenance)})`
                : 'Unverified — cleanup blocked'}
            />
            <Spec label="Retention" value={user.retention_policy === 'ttl' ? `Until ${formatDate(user.expires_at)}` : 'Permanent'} />
            <Spec label="Login session" value={user.auth_session ? `${user.auth_session.session_id} · ${formatDate(user.auth_session.updated_at)}` : 'Not stored'} mono />
            <Spec label="Target devices" value={String(user.target_device_count)} />
          </dl>

          <section className="credential-panel" aria-labelledby="credential-title">
            <div>
              <h3 id="credential-title">Flutter login credential</h3>
              <p>The password is decrypted only after an explicit admin action. Reveals are written to simulator events.</p>
            </div>
            {credential
              ? (
                <dl className="secret-sheet">
                  <div><dt>Email</dt><dd>{credential.email}<CopyButton value={credential.email} /></dd></div>
                  <div><dt>Password</dt><dd><code>{credential.password}</code><CopyButton value={credential.password} /></dd></div>
                </dl>
              )
              : <button className="button button--quiet" onClick={() => void reveal()} type="button">Reveal login</button>}
          </section>

          <section className="detail-section">
            <div className="section-heading section-heading--compact">
              <div><h3>Owned devices</h3><p>{devices.length} registry-tracked device{devices.length === 1 ? '' : 's'}.</p></div>
            </div>
            <div className="entity-list entity-list--full">
              {devices.map((device) => (
                <button className="entity-row" key={device.mac} onClick={() => onSelectDevice(device.mac)} type="button">
                  <Icon name="device" />
                  <span><strong>{device.name}</strong><small>{device.mac} · {device.product_id}</small></span>
                  <StatusBadge status={device.runtime_state} />
                </button>
              ))}
            </div>
          </section>

          <div className="device-data-grid">
            <HistoryPanel title="Recent telemetry" count={telemetry.length} value={telemetry[0]} />
            <HistoryPanel title="Recent commands" count={commands.length} value={commands[0]} />
          </div>
        </>
      )}
    </section>
  )
}

function HistoryPanel({
  title,
  count,
  value,
}: {
  title: string
  count: number
  value?: Record<string, unknown> | DeviceCommand
}) {
  return (
    <section className="data-panel">
      <div className="section-heading section-heading--compact"><div><h3>{title}</h3><p>{count} records loaded.</p></div></div>
      {value
        ? <pre>{JSON.stringify(value, null, 2)}</pre>
        : <p className="empty-inline">No matching history yet.</p>}
    </section>
  )
}

export function DetailHeading({
  id,
  label,
  onBack,
  title,
}: {
  id: string
  label: string
  onBack: () => void
  title: string
}) {
  return (
    <header className="detail-heading">
      <button className="button button--quiet" onClick={onBack} type="button">
        <span className="icon-rotate"><Icon name="arrow" /></span>
        {label}
      </button>
      <h2 id={id}>{title}</h2>
    </header>
  )
}

function Spec({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div><dt>{label}</dt><dd className={mono ? 'mono' : undefined}>{value}</dd></div>
}

const formatDate = (value?: string) => value
  ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  : 'Run has not completed'

const formatProvenance = (value?: SimulatedUser['account_provenance']) => {
  if (value === 'recovered_after_register') return 'recovered registration'
  if (value === 'verified_legacy') return 'verified legacy record'
  return 'registered by simulator'
}
