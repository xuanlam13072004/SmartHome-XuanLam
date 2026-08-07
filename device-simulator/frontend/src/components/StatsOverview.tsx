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
      setError(caught instanceof Error ? caught.message : 'Không tải được thống kê Simulator.')
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
          <h2 id="overview-title">Registry hiện tại</h2>
          <p>Số liệu được đọc trực tiếp từ DeviceSimulatorDB, không dùng giá trị ước lượng.</p>
        </div>
      </div>
      {error && <p className="notice notice--error" role="alert">{error}</p>}
      <div className={`stat-sheet${loading ? ' is-loading' : ''}`} aria-live="polite">
        <StatRow icon="runs" label="Lần chạy đang hoạt động" value={stats.activeRuns} />
        <StatRow icon="user" label="Người dùng ảo" value={stats.totalUsers} emphasis />
        <StatRow icon="device" label="Thiết bị ảo" value={stats.totalDevices} />
        <StatRow icon="signal" label="MQTT trực tuyến" value={stats.onlineDevices} />
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
      <strong>{new Intl.NumberFormat('vi-VN').format(value)}</strong>
    </article>
  )
}
