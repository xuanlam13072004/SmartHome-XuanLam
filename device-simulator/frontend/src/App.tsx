import { useEffect, useState } from 'react'
import { fetchPreflight, getAdminToken } from './api'
import { CommandPalette } from './components/CommandPalette'
import ControlPanel from './components/ControlPanel'
import { DeviceDetail } from './components/DeviceDetail'
import { DevicesPage } from './components/DevicesPage'
import { EventsLog } from './components/EventsLog'
import { Icon, type IconName } from './components/Icon'
import { PreflightPanel } from './components/PreflightPanel'
import RunsList from './components/RunsList'
import StatsOverview from './components/StatsOverview'
import { UserDetail } from './components/UserDetail'
import { UsersPage } from './components/UsersPage'

export type MainView = 'devices' | 'users' | 'create' | 'runs' | 'system'
type DetailView =
  | { type: 'user'; id: string }
  | { type: 'device'; id: string }
  | null

export interface NavigationItem {
  id: MainView
  label: string
  shortLabel?: string
  description: string
  icon: IconName
}

const navigation: NavigationItem[] = [
  {
    id: 'devices',
    label: 'Thiết bị',
    description: 'Xem state, telemetry và mô phỏng phần cứng',
    icon: 'device',
  },
  {
    id: 'users',
    label: 'Người dùng',
    description: 'Tài khoản ảo và thiết bị đang sở hữu',
    icon: 'user',
  },
  {
    id: 'create',
    label: 'Tạo dữ liệu',
    shortLabel: 'Tạo mới',
    description: 'Sinh user và device theo cấu hình',
    icon: 'create',
  },
  {
    id: 'runs',
    label: 'Lần chạy',
    description: 'Tiến độ, retention và cleanup',
    icon: 'runs',
  },
  {
    id: 'system',
    label: 'Hệ thống',
    description: 'Admin token, hạ tầng và sự kiện',
    icon: 'settings',
  },
]

function App() {
  const [view, setView] = useState<MainView>('devices')
  const [detail, setDetail] = useState<DetailView>(null)
  const [infrastructureReady, setInfrastructureReady] = useState(false)
  const [focusRunId, setFocusRunId] = useState<string>()

  useEffect(() => {
    if (!getAdminToken()) return
    void fetchPreflight()
      .then((result) => setInfrastructureReady(result.success))
      .catch(() => setInfrastructureReady(false))
  }, [])

  useEffect(() => {
    const navigateSystem = () => navigate('system')
    window.addEventListener('simulator:navigate-system', navigateSystem)
    return () => window.removeEventListener('simulator:navigate-system', navigateSystem)
  })

  const navigate = (nextView: MainView) => {
    setDetail(null)
    setView(nextView)
  }

  const openUser = (accountId: string) => {
    setDetail({ type: 'user', id: accountId })
    setView('users')
  }

  const openDevice = (mac: string) => {
    setDetail({ type: 'device', id: mac })
    setView('devices')
  }

  const runCreated = (runId: string) => {
    setFocusRunId(runId)
    navigate('runs')
  }

  return (
    <div className="app-shell">
      <aside className="app-rail">
        <button className="brand" onClick={() => navigate('devices')} type="button">
          <span className="brand-mark" aria-hidden="true">SX</span>
          <span><strong>Device Simulator</strong><small>SmartHome XuanLam</small></span>
        </button>

        <nav className="primary-nav" aria-label="Điều hướng chính">
          {navigation.map((item) => (
            <button
              aria-current={view === item.id && !detail ? 'page' : undefined}
              className="nav-button"
              key={item.id}
              onClick={() => navigate(item.id)}
              title={item.description}
              type="button"
            >
              <Icon name={item.icon} />
              <span>{item.shortLabel || item.label}</span>
            </button>
          ))}
        </nav>

        <div className="rail-status">
          <span className={`status-mark status-mark--${infrastructureReady ? 'ok' : 'warning'}`} />
          <span>{infrastructureReady ? 'Sẵn sàng' : 'Cần preflight'}</span>
        </div>
      </aside>

      <div className="app-stage">
        <header className="topbar">
          <div>
            <p>SIMULATOR / LOCAL OPERATIONS</p>
            <h1>{getViewTitle(view, detail)}</h1>
          </div>
          <CommandPalette
            infrastructureReady={infrastructureReady}
            items={navigation}
            onNavigate={navigate}
          />
        </header>

        <main className="main-content">
          {detail?.type === 'user' && (
            <UserDetail
              accountId={detail.id}
              onBack={() => setDetail(null)}
              onSelectDevice={openDevice}
            />
          )}
          {detail?.type === 'device' && (
            <DeviceDetail mac={detail.id} onBack={() => setDetail(null)} />
          )}

          {!detail && view === 'devices' && (
            <DevicesPage
              enabled={infrastructureReady}
              onCreate={() => navigate('create')}
              onSelectDevice={openDevice}
            />
          )}
          {!detail && view === 'users' && (
            <UsersPage
              enabled={infrastructureReady}
              onCreate={() => navigate('create')}
              onSelectUser={openUser}
            />
          )}
          {!detail && view === 'create' && (
            <ControlPanel enabled={infrastructureReady} onCreated={runCreated} />
          )}
          {!detail && view === 'runs' && (
            <RunsList
              enabled={infrastructureReady}
              focusRunId={focusRunId}
              onSelectDevice={openDevice}
              onSelectUser={openUser}
            />
          )}
          {!detail && view === 'system' && (
            <div className="system-page">
              <PreflightPanel onReadyChange={setInfrastructureReady} />
              <StatsOverview enabled={infrastructureReady} />
              <EventsLog enabled={infrastructureReady} />
            </div>
          )}
        </main>

        <footer className="app-footer">
          <span>SmartHome XuanLam Device Simulator</span>
          <span>Registry: DeviceSimulatorDB</span>
          <span>Retention mặc định: 24 giờ</span>
        </footer>
      </div>
    </div>
  )
}

const getViewTitle = (view: MainView, detail: DetailView): string => {
  if (detail?.type === 'user') return 'Chi tiết người dùng'
  if (detail?.type === 'device') return 'Bàn điều khiển thiết bị'
  if (view === 'devices') return 'Thiết bị'
  if (view === 'users') return 'Người dùng'
  if (view === 'create') return 'Tạo dữ liệu mô phỏng'
  if (view === 'runs') return 'Lần chạy mô phỏng'
  return 'Hệ thống'
}

export default App
