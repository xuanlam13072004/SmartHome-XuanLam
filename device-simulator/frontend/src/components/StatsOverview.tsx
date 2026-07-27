import { useCallback, useEffect, useState } from 'react'
import { fetchDevices, fetchRuns, fetchUsers, subscribeStream } from '../api'
import { Icon } from './Icon'

interface Stats {
  activeRuns: number
  totalUsers: number
  totalDevices: number
  onlineDevices: number
}

const initialStats: Stats = {
  activeRuns: 0,
  totalUsers: 0,
  totalDevices: 0,
  onlineDevices: 0,
}

export default function StatsOverview({ enabled }: { enabled: boolean }) {
  const [stats, setStats] = useState(initialStats)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!enabled) return
    try {
      const [runs, users, devices] = await Promise.all([
        fetchRuns(),
        fetchUsers(),
        fetchDevices(),
      ])
      setStats({
        activeRuns: runs.filter((run) => ['queued', 'running'].includes(run.status)).length,
        totalUsers: users.length,
        totalDevices: devices.length,
        onlineDevices: devices.filter((device) => device.runtime_state === 'online').length,
      })
      setError('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load simulator totals')
    } finally {
      setLoading(false)
    }
  }, [enabled])

  useEffect(() => {
    void load()
    if (!enabled) return
    const stop = subscribeStream(() => void load())
    const interval = window.setInterval(() => void load(), 15000)
    return () => {
      stop()
      window.clearInterval(interval)
    }
  }, [enabled, load])

  return (
    <section aria-labelledby="overview-title">
      <div className="section-heading">
        <div>
          <h2 id="overview-title">Current registry</h2>
          <p>Counts are read from DeviceSimulatorDB. No values are estimated.</p>
        </div>
      </div>
      {error && <p className="notice notice--error" role="alert">{error}</p>}
      <div className={`stat-sheet${loading ? ' is-loading' : ''}`} aria-live="polite">
        <StatRow icon="runs" label="Active runs" value={stats.activeRuns} />
        <StatRow icon="user" label="Generated users" value={stats.totalUsers} emphasis />
        <StatRow icon="device" label="Virtual devices" value={stats.totalDevices} />
        <StatRow icon="signal" label="MQTT online" value={stats.onlineDevices} />
      </div>
    </section>
  )
}

function StatRow({
  icon,
  label,
  value,
  emphasis = false,
}: {
  icon: 'runs' | 'user' | 'device' | 'signal'
  label: string
  value: number
  emphasis?: boolean
}) {
  return (
    <article className={`stat-row${emphasis ? ' stat-row--wide' : ''}`}>
      <Icon name={icon} />
      <span>{label}</span>
      <strong>{new Intl.NumberFormat().format(value)}</strong>
    </article>
  )
}
