import { useCallback, useEffect, useState } from 'react'
import { fetchPreflight, getAdminToken } from './api'
import { DeviceDetail } from './components/DeviceDetail'
import { EventsLog } from './components/EventsLog'
import { FactoryPage } from './components/factory/FactoryPage'
import { Icon, type IconName } from './components/Icon'
import { LoadTestPage } from './components/load/LoadTestPage'
import { PreflightPanel } from './components/PreflightPanel'
import { DevicesPage } from './components/registry/DevicesPage'
import { emptyDeviceFilters, type DeviceFilters } from './components/registry/filters'
import { UsersPage } from './components/registry/UsersPage'

export type MainView = 'load' | 'devices' | 'users' | 'factory' | 'system'

const navigation: Array<{ id: MainView; label: string; description: string; icon: IconName }> = [
  { id: 'load', label: 'Kiểm thử tải', description: 'Tạo người dùng, thiết bị và đo tải', icon: 'events' },
  { id: 'devices', label: 'Thiết bị', description: 'Điều khiển, dữ liệu, tem QR', icon: 'device' },
  { id: 'users', label: 'Người dùng', description: 'Tài khoản đăng nhập app', icon: 'user' },
  { id: 'factory', label: 'Xưởng sản xuất', description: 'Tạo thiết bị trắng có tem QR', icon: 'factory' },
  { id: 'system', label: 'Hệ thống', description: 'Token, hạ tầng, nhật ký', icon: 'settings' },
]

function App() {
  const [view, setView] = useState<MainView>('load')
  const [deviceMac, setDeviceMac] = useState<string | null>(null)
  const [deviceFilters, setDeviceFilters] = useState<DeviceFilters>(emptyDeviceFilters)
  const [scenarioFocus, setScenarioFocus] = useState(0)
  const [infrastructureReady, setInfrastructureReady] = useState(false)

  useEffect(() => {
    if (!getAdminToken()) {
      setView('system')
      return
    }
    void fetchPreflight()
      .then((result) => {
        setInfrastructureReady(result.success)
        if (!result.success) setView('system')
      })
      .catch(() => {
        setInfrastructureReady(false)
        setView('system')
      })
  }, [])

  const navigate = useCallback((next: MainView) => {
    setDeviceMac(null)
    setView(next)
  }, [])

  useEffect(() => {
    const toSystem = () => navigate('system')
    window.addEventListener('simulator:navigate-system', toSystem)
    return () => window.removeEventListener('simulator:navigate-system', toSystem)
  }, [navigate])

  const openRunDevices = (runId: string) => {
    setDeviceFilters({ ...emptyDeviceFilters, runId })
    navigate('devices')
  }

  const createRun = () => {
    navigate('load')
    setScenarioFocus((value) => value + 1)
  }

  const current = navigation.find((item) => item.id === view) as (typeof navigation)[number]

  return (
    <div className="app-shell">
      <aside className="app-rail">
        <button className="brand" onClick={() => navigate('load')} type="button">
          <span className="brand-mark" aria-hidden="true">SX</span>
          <span><strong>Device Simulator</strong><small>SmartHome XuanLam</small></span>
        </button>

        <nav className="primary-nav" aria-label="Điều hướng chính">
          {navigation.map((item) => (
            <button
              aria-current={view === item.id ? 'page' : undefined}
              className="nav-button"
              key={item.id}
              onClick={() => navigate(item.id)}
              title={item.description}
              type="button"
            >
              <Icon name={item.icon} />
              <span className="nav-button__text">
                <span>{item.label}</span>
                <small>{item.description}</small>
              </span>
            </button>
          ))}
        </nav>

        <div className="rail-status">
          <span className={`status-mark status-mark--${infrastructureReady ? 'ok' : 'warning'}`} />
          <span>{infrastructureReady ? 'Sẵn sàng' : 'Cần kiểm tra hệ thống'}</span>
        </div>
      </aside>

      <div className="app-stage">
        <header className="topbar">
          <div>
            <p>SIMULATOR / {current.label.toUpperCase()}</p>
            <h1>{deviceMac ? 'Bàn điều khiển thiết bị' : current.label}</h1>
          </div>
        </header>

        <main className="main-content">
          {deviceMac ? (
            <DeviceDetail mac={deviceMac} onBack={() => setDeviceMac(null)} />
          ) : (
            <>
              {view === 'load' && (
                <LoadTestPage enabled={infrastructureReady} focusScenario={scenarioFocus} onOpenDevices={openRunDevices} />
              )}
              {view === 'devices' && (
                <DevicesPage
                  enabled={infrastructureReady}
                  filters={deviceFilters}
                  onCreateRun={createRun}
                  onFilters={setDeviceFilters}
                  onManufacture={() => navigate('factory')}
                  onSelectDevice={setDeviceMac}
                />
              )}
              {view === 'users' && (
                <UsersPage enabled={infrastructureReady} onCreateRun={createRun} onSelectDevice={setDeviceMac} />
              )}
              {view === 'factory' && <FactoryPage enabled={infrastructureReady} onSelectDevice={setDeviceMac} />}
              {view === 'system' && (
                <div className="system-page">
                  <PreflightPanel onReadyChange={setInfrastructureReady} />
                  <EventsLog enabled={infrastructureReady} />
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  )
}

export default App
