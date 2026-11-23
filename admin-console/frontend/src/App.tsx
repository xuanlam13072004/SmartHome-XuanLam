import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchPreflight, fetchSession, type SessionState, SIGNED_OUT_EVENT, signOut } from './api'
import { AccountsTab } from './components/admin/AccountsTab'
import { AssistantTab } from './components/admin/AssistantTab'
import { AuditTab } from './components/admin/AuditTab'
import { OverviewTab } from './components/admin/OverviewTab'
import { PaymentsTab } from './components/admin/PaymentsTab'
import { DeviceDetail } from './components/DeviceDetail'
import { EventsLog } from './components/EventsLog'
import { FactoryPage } from './components/factory/FactoryPage'
import { readError } from './components/format'
import { Icon, type IconName } from './components/Icon'
import { LoadTestPage } from './components/load/LoadTestPage'
import { PreflightPanel } from './components/PreflightPanel'
import { DevicesPage } from './components/registry/DevicesPage'
import { emptyDeviceFilters, type DeviceFilters } from './components/registry/filters'
import { UsersPage } from './components/registry/UsersPage'
import { accessFor, type ConsoleAccess, ConsoleContext } from './console/ConsoleContext'
import { FirstPasswordPage, LoginPage } from './console/LoginPage'
import { MyAccountPage } from './console/MyAccountPage'
import { StaffPage } from './console/StaffPage'

export type MainView =
  | 'overview' | 'accounts' | 'payments' | 'assistant' | 'audit'
  | 'load' | 'devices' | 'users' | 'factory' | 'system'
  | 'staff' | 'me'

interface NavItem {
  id: MainView
  label: string
  description: string
  icon: IconName
  /** Needed to see the item; Simulator items also need the Console connected to a Simulator. */
  permission?: string
  simulator?: boolean
}

const groups: Array<{ title: string; items: NavItem[] }> = [
  {
    title: 'Vận hành',
    items: [
      { id: 'overview', label: 'Tổng quan', description: 'Số liệu và biểu đồ', icon: 'overview', permission: 'overview.view' },
      { id: 'accounts', label: 'Tài khoản khách', description: 'Tìm, khóa, tặng gói', icon: 'user', permission: 'accounts.view' },
      { id: 'payments', label: 'Thanh toán', description: 'Đơn hàng, tiền chưa khớp', icon: 'payments', permission: 'payments.view' },
      { id: 'assistant', label: 'Trợ lý', description: 'Lượt dùng và token', icon: 'assistant', permission: 'assistant.view' },
      { id: 'audit', label: 'Nhật ký', description: 'Ai đã làm gì, vì sao', icon: 'audit', permission: 'audit.view' },
    ],
  },
  {
    title: 'Simulator',
    items: [
      { id: 'load', label: 'Kiểm thử tải', description: 'Tạo người dùng, thiết bị và đo tải', icon: 'events', permission: 'simulator.view', simulator: true },
      { id: 'devices', label: 'Thiết bị ảo', description: 'Điều khiển, dữ liệu, tem QR', icon: 'device', permission: 'simulator.view', simulator: true },
      { id: 'users', label: 'Người dùng ảo', description: 'Tài khoản đăng nhập app', icon: 'staff', permission: 'simulator.view', simulator: true },
      { id: 'factory', label: 'Xưởng sản xuất', description: 'Thiết bị trắng có tem QR', icon: 'factory', permission: 'simulator.view', simulator: true },
      { id: 'system', label: 'Hệ thống Simulator', description: 'Hạ tầng, nhật ký vận hành', icon: 'settings', permission: 'simulator.view', simulator: true },
    ],
  },
  {
    title: 'Công ty',
    items: [
      { id: 'staff', label: 'Nhân viên', description: 'Tài khoản và quyền', icon: 'shield', permission: 'staff.manage' },
      { id: 'me', label: 'Tài khoản của tôi', description: 'Mật khẩu, phiên đăng nhập', icon: 'key' },
    ],
  },
]

const visible = (access: ConsoleAccess, item: NavItem) =>
  (!item.permission || access.can(item.permission)) && (!item.simulator || access.simulator)

/** Signed in: the navigation shows only what this staff member may use. */
function Shell({ access, onSignOut }: { access: ConsoleAccess; onSignOut: () => void }) {
  const navigation = useMemo(
    () => groups.map((group) => ({ ...group, items: group.items.filter((item) => visible(access, item)) })).filter((group) => group.items.length > 0),
    [access],
  )
  const allowed = navigation.flatMap((group) => group.items)
  const [view, setView] = useState<MainView>(allowed[0]?.id ?? 'me')
  const [deviceMac, setDeviceMac] = useState<string | null>(null)
  const [deviceFilters, setDeviceFilters] = useState<DeviceFilters>(emptyDeviceFilters)
  const [scenarioFocus, setScenarioFocus] = useState(0)
  const [simulatorReady, setSimulatorReady] = useState(false)
  const [focusAccount, setFocusAccount] = useState<{ id: string; email: string; at: number } | null>(null)
  const canSimulator = allowed.some((item) => item.simulator)
  const canManageSimulator = access.can('simulator.manage')

  useEffect(() => {
    if (!canSimulator) return
    void fetchPreflight()
      .then((result) => setSimulatorReady(result.success))
      .catch(() => setSimulatorReady(false))
  }, [canSimulator])

  const navigate = useCallback((next: MainView) => {
    setDeviceMac(null)
    setView(next)
  }, [])

  useEffect(() => {
    const toSystem = () => navigate('system')
    window.addEventListener('simulator:navigate-system', toSystem)
    return () => window.removeEventListener('simulator:navigate-system', toSystem)
  }, [navigate])

  const openAccount = access.can('accounts.view')
    ? (account: { id: string; email: string }) => {
      setFocusAccount({ ...account, at: Date.now() })
      navigate('accounts')
    }
    : undefined

  const current = allowed.find((item) => item.id === view) ?? allowed[0]
  const simulatorView = current?.simulator === true

  return (
    <div className="app-shell">
      <aside className="app-rail">
        <button className="brand" onClick={() => allowed[0] && navigate(allowed[0].id)} type="button">
          <span className="brand-mark" aria-hidden="true">SX</span>
          <span><strong>Admin Console</strong><small>SmartHome XuanLam</small></span>
        </button>

        <nav className="primary-nav" aria-label="Điều hướng chính">
          {navigation.map((group) => (
            <div className="nav-group" key={group.title}>
              <p className="nav-group__title">{group.title}</p>
              {group.items.map((item) => (
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
            </div>
          ))}
        </nav>

        <div className="rail-status rail-status--staff">
          <span>
            <strong>{access.staff.full_name}</strong>
            <small>{access.staff.is_root ? 'Admin gốc' : access.staff.email}</small>
          </span>
          <button className="icon-button" onClick={onSignOut} title="Đăng xuất" type="button">
            <Icon name="logout" />
            <span className="visually-hidden">Đăng xuất</span>
          </button>
        </div>
      </aside>

      <div className="app-stage">
        <header className="topbar">
          <div>
            <p>{simulatorView ? 'SIMULATOR' : 'ADMIN CONSOLE'} / {(current?.label ?? '').toUpperCase()}</p>
            <h1>{deviceMac ? 'Bàn điều khiển thiết bị' : current?.label}</h1>
          </div>
        </header>

        <main className="main-content">
          {simulatorView && !canManageSimulator && (
            <p className="notice notice--warning console-readonly">
              Bạn chỉ có quyền xem Simulator: các nút tạo, dừng, điều khiển sẽ bị từ chối.
            </p>
          )}
          {deviceMac ? (
            <DeviceDetail mac={deviceMac} onBack={() => setDeviceMac(null)} />
          ) : (
            <>
              {view === 'overview' && <OverviewTab onOpenPayments={access.can('payments.view') ? () => navigate('payments') : undefined} />}
              {view === 'accounts' && <AccountsTab focus={focusAccount} />}
              {view === 'payments' && <PaymentsTab onOpenAccount={openAccount} />}
              {view === 'assistant' && <AssistantTab onOpenAccount={openAccount} />}
              {view === 'audit' && <AuditTab onOpenAccount={openAccount} />}
              {view === 'load' && (
                <LoadTestPage
                  enabled={simulatorReady}
                  focusScenario={scenarioFocus}
                  onOpenDevices={(runId) => {
                    setDeviceFilters({ ...emptyDeviceFilters, runId })
                    navigate('devices')
                  }}
                />
              )}
              {view === 'devices' && (
                <DevicesPage
                  enabled={simulatorReady}
                  filters={deviceFilters}
                  onCreateRun={() => { navigate('load'); setScenarioFocus((value) => value + 1) }}
                  onFilters={setDeviceFilters}
                  onManufacture={() => navigate('factory')}
                  onSelectDevice={setDeviceMac}
                />
              )}
              {view === 'users' && (
                <UsersPage
                  enabled={simulatorReady}
                  onCreateRun={() => { navigate('load'); setScenarioFocus((value) => value + 1) }}
                  onSelectDevice={setDeviceMac}
                />
              )}
              {view === 'factory' && <FactoryPage enabled={simulatorReady} onSelectDevice={setDeviceMac} />}
              {view === 'system' && (
                <div className="system-page">
                  <PreflightPanel onReadyChange={setSimulatorReady} />
                  <EventsLog enabled={simulatorReady} />
                </div>
              )}
              {view === 'staff' && <StaffPage />}
              {view === 'me' && <MyAccountPage />}
            </>
          )}
        </main>
      </div>
    </div>
  )
}

function App() {
  // undefined: still asking who is signed in; null: nobody.
  const [session, setSession] = useState<SessionState | null | undefined>(undefined)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    try {
      setSession(await fetchSession())
      setError('')
    } catch (caught) {
      setError(readError(caught, 'Không kết nối được Admin Console.'))
      setSession(null)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const ended = () => setSession(null)
    window.addEventListener(SIGNED_OUT_EVENT, ended)
    return () => window.removeEventListener(SIGNED_OUT_EVENT, ended)
  }, [refresh])

  const leave = useCallback(() => {
    void signOut().catch(() => undefined).finally(() => setSession(null))
  }, [])

  const access = useMemo(() => (session ? accessFor(session.staff, session.simulator) : null), [session])

  if (session === undefined) {
    return <main className="console-gate"><div className="registry-skeleton" aria-label="Đang tải"><span /><span /></div></main>
  }
  if (!session || !access) {
    return (
      <>
        {error && <p className="notice notice--error console-gate__error" role="alert">{error}</p>}
        <LoginPage onSignedIn={() => void refresh()} />
      </>
    )
  }
  if (session.staff.must_change_password) {
    return <FirstPasswordPage name={session.staff.full_name} onDone={() => void refresh()} onSignOut={leave} />
  }
  // Someone with no permission yet still gets "Tài khoản của tôi".
  return (
    <ConsoleContext.Provider value={access}>
      <Shell access={access} onSignOut={leave} />
    </ConsoleContext.Provider>
  )
}

export default App
