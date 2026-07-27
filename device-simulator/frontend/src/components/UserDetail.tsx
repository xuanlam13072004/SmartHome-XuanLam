import { useEffect, useState } from 'react'
import { fetchUser, revealUserCredential } from '../api'
import type { SimulatedDevice, SimulatedUser } from '../types'
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
  const [credential, setCredential] = useState<{ email: string; username: string; password: string } | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    void fetchUser(accountId).then((result) => {
      setUser(result.user)
      setDevices(result.devices)
      setError('')
    }).catch((caught) => {
      setError(caught instanceof Error ? caught.message : 'Could not load simulated user')
    }).finally(() => setLoading(false))
  }, [accountId])

  const reveal = async () => {
    try {
      const result = await revealUserCredential(accountId)
      setCredential(result.credential)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not reveal login credential')
    }
  }

  return (
    <section aria-labelledby="user-title">
      <DetailHeading id="user-title" label="Back to runs" onBack={onBack} title={user?.full_name || 'Simulated user'} />
      {error && <p className="notice notice--error" role="alert">{error}</p>}
      {loading && <div className="skeleton-list" />}
      {user && (
        <>
          <dl className="detail-spec">
            <Spec label="Account ID" value={user.account_id || 'Registration pending'} mono />
            <Spec label="Email" value={user.email} />
            <Spec label="Username" value={user.username} />
            <Spec label="Generation" value={user.generation_state} />
            <Spec label="Retention" value={user.retention_policy === 'ttl' ? `Until ${formatDate(user.expires_at)}` : 'Permanent'} />
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
        </>
      )}
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
