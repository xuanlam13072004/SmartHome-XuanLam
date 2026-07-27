import { useEffect, useState } from 'react'
import { fetchPreflight, getAdminToken } from './api'
import { CommandPalette } from './components/CommandPalette'
import ControlPanel from './components/ControlPanel'
import { DeviceDetail } from './components/DeviceDetail'
import { EventsLog } from './components/EventsLog'
import { Icon, type IconName } from './components/Icon'
import { PreflightPanel } from './components/PreflightPanel'
import RunsList from './components/RunsList'
import StatsOverview from './components/StatsOverview'
import { UserDetail } from './components/UserDetail'

export type MainView = 'overview' | 'runs' | 'create' | 'events'
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
    id: 'runs',
    label: 'Registry',
    description: 'Browse generated runs, users and devices',
    icon: 'runs',
  },
  {
    id: 'create',
    label: 'Create',
    description: 'Configure and start a virtual workload',
    icon: 'create',
  },
  {
    id: 'overview',
    label: 'Infrastructure',
    shortLabel: 'Infra',
    description: 'Verify dependencies and inspect totals',
    icon: 'overview',
  },
  {
    id: 'events',
    label: 'Events',
    description: 'Review runtime and audit history',
    icon: 'events',
  },
]

function App() {
  const [view, setView] = useState<MainView>('runs')
  const [detail, setDetail] = useState<DetailView>(null)
  const [infrastructureReady, setInfrastructureReady] = useState(false)
  const [focusRunId, setFocusRunId] = useState<string>()

  useEffect(() => {
    if (!getAdminToken()) return
    void fetchPreflight()
      .then((result) => setInfrastructureReady(result.success))
      .catch(() => setInfrastructureReady(false))
  }, [])

  const navigate = (nextView: MainView) => {
    setDetail(null)
    setView(nextView)
  }

  const openUser = (accountId: string) => {
    setDetail({ type: 'user', id: accountId })
    setView('runs')
  }

  const openDevice = (mac: string) => {
    setDetail({ type: 'device', id: mac })
    setView('runs')
  }

  const runCreated = (runId: string) => {
    setFocusRunId(runId)
    navigate('runs')
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <button className="brand" onClick={() => navigate('runs')} type="button">
          <span className="brand-mark" aria-hidden="true">SX</span>
          <span>
            <strong>Device Simulator</strong>
            <small>SmartHome XuanLam</small>
          </span>
        </button>

        <nav className="primary-nav" aria-label="Primary navigation">
          {navigation.map((item) => (
            <button
              aria-current={view === item.id && !detail ? 'page' : undefined}
              className="nav-button"
              key={item.id}
              onClick={() => navigate(item.id)}
              type="button"
            >
              <Icon name={item.icon} />
              <span>{item.shortLabel || item.label}</span>
            </button>
          ))}
        </nav>

        <CommandPalette
          infrastructureReady={infrastructureReady}
          items={navigation}
          onNavigate={navigate}
        />
      </header>

      <div className="workspace">
        <header className="topbar">
          <div>
            <p className="machine-label">SIMULATOR / LOCAL OPERATIONS</p>
            <h1>{getViewTitle(view, detail)}</h1>
          </div>
          <div className="topbar-status">
            <span className={`status-mark status-mark--${infrastructureReady ? 'ok' : 'warning'}`} />
            {infrastructureReady ? 'Infrastructure ready' : 'Preflight required'}
          </div>
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
          {!detail && view === 'overview' && (
            <div className="overview-layout">
              <PreflightPanel onReadyChange={setInfrastructureReady} />
              <StatsOverview enabled={infrastructureReady} />
            </div>
          )}
          {!detail && view === 'runs' && (
            <RunsList
              enabled={infrastructureReady}
              focusRunId={focusRunId}
              onSelectDevice={openDevice}
              onSelectUser={openUser}
            />
          )}
          {!detail && view === 'create' && (
            <ControlPanel enabled={infrastructureReady} onCreated={runCreated} />
          )}
          {!detail && view === 'events' && <EventsLog enabled={infrastructureReady} />}
        </main>

        <footer className="masthead-footer">
          <div>
            <strong>DEVICE SIMULATOR</strong>
            <p>Virtual identities. Real contracts. Controlled cleanup.</p>
          </div>
          <dl>
            <div><dt>Registry</dt><dd>DeviceSimulatorDB</dd></div>
            <div><dt>Retention</dt><dd>24h after completion</dd></div>
          </dl>
        </footer>
      </div>
    </div>
  )
}

const getViewTitle = (view: MainView, detail: DetailView): string => {
  if (detail?.type === 'user') return 'User record'
  if (detail?.type === 'device') return 'Device record'
  if (view === 'overview') return 'Infrastructure'
  if (view === 'runs') return 'Run registry'
  if (view === 'create') return 'New workload'
  return 'Event history'
}

export default App
