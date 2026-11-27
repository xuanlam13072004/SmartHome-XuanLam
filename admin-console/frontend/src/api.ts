import type {
  AdminAccountDetail,
  AdminAccountFilter,
  AdminAccountRow,
  AdminAssistant,
  AdminAuditItem,
  AdminGiftablePlan,
  AdminWeather,
  AdminOrder,
  AdminOverview,
  AdminPayments,
  AdminPaymentTab,
  CameraSegment,
  CameraStatus,
  CatalogProduct,
  DeviceDetailPayload,
  DeviceLivePayload,
  DevicePairing,
  DeviceStatePatch,
  FactoryBatch,
  FactoryDevice,
  OwnSession,
  IngestLatency,
  Overview,
  Page,
  PermissionInfo,
  PermissionPreset,
  Preflight,
  ProbeList,
  ProbeParams,
  ProbeResult,
  RunConfig,
  SimulatedDevice,
  SimulatedUser,
  SimulationRun,
  SimulatorEvent,
  Staff,
  StaffMember,
  WeatherAccountMock,
  WeatherMock,
} from './types'

/** Everything goes to the Admin Console backend on the same origin (docs/architecture/admin.md). */
const API_ROOT = '/api'
/** The Simulator section: the Console checks the staff member's permission and forwards. */
const SIMULATOR = `${API_ROOT}/simulator`

/** Sent with every change: proves the request comes from the Console's own pages. */
const CONSOLE_HEADER = { 'X-Console-Request': '1' }

export class ApiError extends Error {
  readonly status: number
  readonly code?: string

  constructor(
    message: string,
    status: number,
    code?: string,
  ) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** The session ended (expired, signed out elsewhere, locked): the app shows the sign-in page. */
export const SIGNED_OUT_EVENT = 'console:signed-out'

const signedOut = (status: number, code?: string) => {
  if (status === 401 && code === 'STAFF_SESSION_INVALID') window.dispatchEvent(new CustomEvent(SIGNED_OUT_EVENT))
}

/** [path] is under /api (for example /simulator/devices or /admin/overview). */
const request = async <T>(
  path: string,
  init: RequestInit = {},
  acceptedErrorStatuses: readonly number[] = [],
): Promise<T> => {
  const hasBody = init.body !== undefined && init.body !== null
  const method = (init.method || 'GET').toUpperCase()
  const response = await fetch(`${API_ROOT}${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(method === 'GET' ? {} : CONSOLE_HEADER),
      ...init.headers,
    },
  })
  const data = await response.json().catch(() => null) as {
    error?: string | { code?: string; message?: string }
  } | null
  if (!response.ok && !acceptedErrorStatuses.includes(response.status)) {
    const code = typeof data?.error === 'object' ? data.error.code : undefined
    signedOut(response.status, code)
    const message = typeof data?.error === 'string'
      ? data.error
      : data?.error?.message || ([502, 504].includes(response.status)
        ? 'Admin Console chưa kết nối được dịch vụ phía sau (API Gateway hoặc Simulator). Kiểm tra các dịch vụ đã khởi động.'
        : `Admin Console returned HTTP ${response.status}`)
    throw new ApiError(message, response.status, code)
  }
  return data as T
}

/** A call to the Device Simulator through the Console. */
const sim = <T = unknown>(path: string, init: RequestInit = {}, acceptedErrorStatuses: readonly number[] = []) =>
  request<T>(`/simulator${path}`, init, acceptedErrorStatuses)

/** A file or stream from the Simulator (the session cookie goes with it). */
const simFetch = async (path: string, init: RequestInit = {}): Promise<Response> => {
  const response = await fetch(`${SIMULATOR}${path}`, { ...init, credentials: 'same-origin' })
  if (response.status === 401) signedOut(401, 'STAFF_SESSION_INVALID')
  return response
}

// A valid token can still produce 503 while one infrastructure dependency is
// unavailable. Preserve that response so the UI can show individual checks;
// authentication failures such as 401 still throw.
export const fetchPreflight = () => sim<Preflight>('/preflight', {}, [503])

export const fetchRuns = async (): Promise<SimulationRun[]> =>
  (await sim<{ runs: SimulationRun[] }>('/simulation-runs')).runs

export const fetchRun = async (id: string): Promise<SimulationRun> =>
  (await sim<{ run: SimulationRun }>(`/simulation-runs/${encodeURIComponent(id)}`)).run

export const fetchOverview = () => sim<Overview>('/overview')

/** Measured by the API Gateway (the Simulator does not read the system's database). */
export const fetchIngestLatency = async (): Promise<IngestLatency | null> =>
  (await request<{ ingest_latency: IngestLatency | null }>('/admin/load/ingest-latency')).ingest_latency

export interface UserQuery {
  runId?: string
  q?: string
  page?: number
  pageSize?: number
}

export const fetchUsersPage = async (query: UserQuery = {}): Promise<Page<SimulatedUser>> => {
  const params = new URLSearchParams()
  if (query.runId) params.set('run_id', query.runId)
  if (query.q) params.set('q', query.q)
  params.set('page', String(query.page || 1))
  params.set('page_size', String(query.pageSize || 50))
  const result = await sim<Omit<Page<SimulatedUser>, 'items'> & { users: SimulatedUser[] }>(`/users?${params}`)
  return { page: result.page, page_size: result.page_size, total: result.total, items: result.users }
}

export const fetchUser = async (accountId: string) =>
  sim<{
    user: SimulatedUser
    devices: SimulatedDevice[]
  }>(
    `/users/${encodeURIComponent(accountId)}`,
  )

export const revealUserCredential = async (accountId: string) =>
  sim<{ credential: { email: string; password: string } }>(
    `/users/${encodeURIComponent(accountId)}/reveal-credential`,
    { method: 'POST' },
  )

export const userAction = (
  accountId: string,
  action: 'relogin' | 'refresh-session' | 'make-permanent' | 'cleanup',
) => sim(`/users/${encodeURIComponent(accountId)}/${action}`, { method: 'POST' })

export interface DeviceQuery {
  runId?: string
  userId?: string
  productId?: string
  status?: string
  origin?: 'run' | 'factory'
  q?: string
  page?: number
  pageSize?: number
}

/** Paged registry; filtering and counting happen on the server. */
export const fetchDevicesPage = async (query: DeviceQuery = {}): Promise<Page<SimulatedDevice>> => {
  const params = new URLSearchParams()
  if (query.runId) params.set('run_id', query.runId)
  if (query.userId) params.set('user_id', query.userId)
  if (query.productId) params.set('product_id', query.productId)
  if (query.status) params.set('status', query.status)
  if (query.origin) params.set('origin', query.origin)
  if (query.q) params.set('q', query.q)
  params.set('page', String(query.page || 1))
  params.set('page_size', String(query.pageSize || 50))
  const result = await sim<Omit<Page<SimulatedDevice>, 'items'> & { devices: SimulatedDevice[] }>(`/devices?${params}`)
  return { page: result.page, page_size: result.page_size, total: result.total, items: result.devices }
}

export const fetchDevice = async (mac: string) =>
  sim<DeviceDetailPayload>(`/devices/${encodeURIComponent(mac)}`)

export const fetchDeviceLive = async (mac: string) =>
  sim<DeviceLivePayload>(`/devices/${encodeURIComponent(mac)}/live`)

export const setDeviceConnection = (mac: string, online: boolean) =>
  sim(`/devices/${encodeURIComponent(mac)}/${online ? 'connect' : 'disconnect'}`, {
    method: 'POST',
  })

export const sendDeviceTelemetry = (mac: string) =>
  sim(`/devices/${encodeURIComponent(mac)}/telemetry`, { method: 'POST' })

export const deviceAction = (
  mac: string,
  action: 'pause' | 'resume' | 'force-offline' | 'reconnect' | 'reset-state',
) => sim(`/devices/${encodeURIComponent(mac)}/${action}`, { method: 'POST' })

export const updateDeviceState = (
  mac: string,
  state: DeviceStatePatch,
) => sim<{
  state: NonNullable<SimulatedDevice['state_snapshot']>
  delivery: 'publish_requested' | 'stored_offline'
}>(`/devices/${encodeURIComponent(mac)}/state`, {
  method: 'PATCH',
  body: JSON.stringify(state),
})

export const performPhysicalPumpAction = (mac: string, action: 'start' | 'stop') =>
  sim<{ state: NonNullable<SimulatedDevice['state_snapshot']> }>(
    `/devices/${encodeURIComponent(mac)}/physical-pump`,
    { method: 'POST', body: JSON.stringify({ action }) },
  )

export const performPhysicalSirenAction = (
  mac: string,
  action: 'test_siren' | 'mute_siren' | 'resume_siren',
  durationSeconds = 0,
) => sim<{
  state: NonNullable<SimulatedDevice['state_snapshot']>
  delivery: 'publish_requested' | 'stored_offline'
}>(`/devices/${encodeURIComponent(mac)}/physical-siren`, {
  method: 'POST',
  body: JSON.stringify({
    action,
    duration_seconds: durationSeconds,
  }),
})

export const pressPhysicalKeypad = (mac: string, key: string) =>
  sim<{
    state: NonNullable<SimulatedDevice['state_snapshot']>
    entrance: NonNullable<DeviceDetailPayload['virtual_hardware']>['entrance']
    delivery: 'publish_requested' | 'queued_offline'
  }>(`/devices/${encodeURIComponent(mac)}/physical-keypad`, {
    method: 'POST',
    body: JSON.stringify({ key }),
  })

export const setPhysicalDoorPosition = (
  mac: string,
  angleDegrees: number,
  sensorState: 'calibrating' | 'ready' | 'fault',
) => sim<{
  state: NonNullable<SimulatedDevice['state_snapshot']>
  entrance: NonNullable<DeviceDetailPayload['virtual_hardware']>['entrance']
  delivery: 'publish_requested' | 'queued_offline'
}>(`/devices/${encodeURIComponent(mac)}/physical-door`, {
  method: 'POST',
  body: JSON.stringify({
    angle_degrees: angleDegrees,
    sensor_state: sensorState,
  }),
})

export const fetchCameraStatus = (mac: string) =>
  sim<{ status: CameraStatus; segments: CameraSegment[] }>(`/devices/${encodeURIComponent(mac)}/camera`)

export const startCameraSource = (mac: string, body: {
  session_id: string
  force: boolean
  video: { codec: string; width: number; height: number; framerate: number; description: string }
  audio: { codec: 'mp4a.40.2'; sample_rate: number; channels: number; description?: string } | null
}) => sim<{ status: CameraStatus }>(`/devices/${encodeURIComponent(mac)}/camera/source`, {
  method: 'POST',
  body: JSON.stringify({ action: 'start', ...body }),
})

export const stopCameraSource = (mac: string, sessionId: string) =>
  sim<{ status: CameraStatus }>(`/devices/${encodeURIComponent(mac)}/camera/source`, {
    method: 'POST',
    body: JSON.stringify({ action: 'stop', session_id: sessionId }),
  })

export const sendCameraChunks = (mac: string, sessionId: string, body: Uint8Array) =>
  sim<null>(
    `/devices/${encodeURIComponent(mac)}/camera/chunks?session_id=${encodeURIComponent(sessionId)}`,
    { method: 'POST', body: body as BodyInit, headers: { 'Content-Type': 'application/octet-stream' } },
  )

/** Downloads one recorded minute (fMP4) for local playback in the dashboard. */
export const fetchCameraSegment = async (mac: string, segmentId: string): Promise<Blob> => {
  const response = await simFetch(`/devices/${encodeURIComponent(mac)}/camera/segments/${encodeURIComponent(segmentId)}`)
  if (!response.ok) throw new ApiError(`Không tải được bản ghi (HTTP ${response.status})`, response.status)
  return response.blob()
}

/** QR label content of any simulated device (decrypts the factory secret). */
export const fetchDevicePairing = async (mac: string): Promise<DevicePairing> =>
  (await sim<{ pairing: DevicePairing }>(`/devices/${encodeURIComponent(mac)}/pairing`)).pairing

export const fetchFactoryBatches = async () =>
  sim<{ batches: FactoryBatch[]; max_batch_size: number }>('/factory/batches')

export const manufactureBatch = (body: {
  product_id: string
  quantity: number
  power_on: boolean
  note?: string
}) => sim<{ batch: FactoryBatch; devices: FactoryDevice[] }>('/factory/batches', {
  method: 'POST',
  body: JSON.stringify(body),
})

export const fetchFactoryDevices = async (options: { batchId?: string; includePairing?: boolean } = {}) => {
  const params = new URLSearchParams()
  if (options.batchId) params.set('batch_id', options.batchId)
  if (options.includePairing) params.set('include_pairing', '1')
  return (await sim<{ devices: FactoryDevice[] }>(`/factory/devices?${params}`)).devices
}

export const setFactoryPower = (mac: string, on: boolean) =>
  sim<{ runtime_state: string }>(`/factory/devices/${encodeURIComponent(mac)}/power`, {
    method: 'POST',
    body: JSON.stringify({ on }),
  })

export const scrapFactoryDevice = (mac: string) =>
  sim(`/factory/devices/${encodeURIComponent(mac)}/scrap`, { method: 'POST' })

export const scrapUnclaimedBatch = (batchId: string) =>
  sim<{ scrapped: number; kept: number }>(
    `/factory/batches/${encodeURIComponent(batchId)}/scrap-unclaimed`,
    { method: 'POST' },
  )

export const createRun = (config: RunConfig) =>
  sim<{ run_id: string; status: RunStatus }>('/simulation-runs', {
    method: 'POST',
    body: JSON.stringify(config),
  })

export const runAction = (
  id: string,
  action: 'pause' | 'resume' | 'cancel' | 'cleanup' | 'stop-runtime' | 'restart-runtime',
) => sim(`/simulation-runs/${encodeURIComponent(id)}/${action}`, { method: 'POST' })

export const setRunPermanent = (id: string, permanent: boolean) =>
  sim(`/simulation-runs/${encodeURIComponent(id)}/retention`, {
    method: 'POST',
    body: JSON.stringify({ policy: permanent ? 'permanent' : 'auto_24h' }),
  })

export const fetchEvents = async (options: { runId?: string; problemsOnly?: boolean } = {}): Promise<SimulatorEvent[]> => {
  const params = new URLSearchParams()
  if (options.runId) params.set('run_id', options.runId)
  if (options.problemsOnly) params.set('severity', 'warning')
  return (await sim<{ events: SimulatorEvent[] }>(`/events?${params}`)).events
}

export const fetchCatalog = async (): Promise<CatalogProduct[]> =>
  (await sim<{ products: CatalogProduct[] }>('/catalog/products')).products

export const subscribeStream = (
  onEvent: (event: SimulatorEvent) => void,
  onError?: (error: Error) => void,
): (() => void) => {
  const controller = new AbortController()
  const connect = async () => {
    let retryMs = 1000
    while (!controller.signal.aborted) {
      try {
        const response = await simFetch('/events/stream', { signal: controller.signal })
        if (!response.ok || !response.body) {
          throw new ApiError('Could not open simulator event stream', response.status)
        }
        retryMs = 1000
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const frames = buffer.split('\n\n')
          buffer = frames.pop() || ''
          for (const frame of frames) {
            const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
            if (!dataLine) continue
            try {
              const parsed = JSON.parse(dataLine.slice(6)) as SimulatorEvent
              if (parsed.type !== 'connected') onEvent(parsed)
            } catch {
              // Ignore one malformed SSE frame and keep the stream alive.
            }
          }
        }
        if (!controller.signal.aborted) throw new Error('Simulator event stream closed')
      } catch (error) {
        if (controller.signal.aborted) break
        onError?.(error instanceof Error ? error : new Error(String(error)))
        await new Promise<void>((resolve) => {
          const timer = window.setTimeout(resolve, retryMs)
          controller.signal.addEventListener('abort', () => {
            window.clearTimeout(timer)
            resolve()
          }, { once: true })
        })
        retryMs = Math.min(retryMs * 2, 30000)
      }
    }
  }
  void connect()

  return () => controller.abort()
}

type RunStatus = SimulationRun['status']

// ── End-to-end probes ──────────────────────────────────────────────────────

export const fetchProbes = () => sim<ProbeList>('/probes')

export const startProbe = async (params: ProbeParams): Promise<ProbeResult> =>
  (await sim<{ probe: ProbeResult }>('/probes', { method: 'POST', body: JSON.stringify(params) })).probe

export const stopProbe = (id: string) =>
  sim<{ success: boolean }>(`/probes/${encodeURIComponent(id)}/stop`, { method: 'POST' })

/** Saves a probe's samples (CSV) or full result (JSON) as a file. */
export const downloadProbe = async (id: string, format: 'csv' | 'json'): Promise<void> => {
  const path = format === 'csv' ? `/probes/${encodeURIComponent(id)}/csv` : `/probes/${encodeURIComponent(id)}`
  const response = await simFetch(path)
  if (!response.ok) throw new ApiError(`Simulator API returned HTTP ${response.status}`, response.status)
  const blob = format === 'csv'
    ? await response.blob()
    : new Blob([JSON.stringify((await response.json()).probe, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `probe-${id.slice(0, 8)}.${format}`
  link.click()
  URL.revokeObjectURL(url)
}

// ── Administration ("Quản trị"): the backend forwards to the API Gateway's /admin ──

const adminQuery = (params: Record<string, string | number | undefined>): string => {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value))
  }
  const text = query.toString()
  return text ? `?${text}` : ''
}

const adminPost = <T>(path: string, body: object) =>
  request<T>(`/admin${path}`, { method: 'POST', body: JSON.stringify(body) })

export const fetchAdminOverview = () => request<AdminOverview>('/admin/overview')

export const fetchAdminAssistant = () => request<AdminAssistant>('/admin/assistant')

export const fetchAdminPlans = async (): Promise<AdminGiftablePlan[]> =>
  (await request<{ plans: AdminGiftablePlan[] }>('/admin/plans')).plans

export const fetchAdminAccounts = (query: { q?: string; filter: AdminAccountFilter; page: number }) =>
  request<Page<AdminAccountRow>>(`/admin/accounts${adminQuery({ q: query.q, filter: query.filter, page: query.page })}`)

export const fetchAdminAccount = (id: string) =>
  request<AdminAccountDetail>(`/admin/accounts/${encodeURIComponent(id)}`)

export type AdminAccountAction = 'disable' | 'enable' | 'sign-out'

export const adminAccountAction = (id: string, action: AdminAccountAction, reason: string) =>
  adminPost<{ status?: string; signed_out_sessions?: number }>(`/accounts/${encodeURIComponent(id)}/${action}`, { reason })

export const giftAdminPlan = (id: string, gift: { plan_code: string; days: number; reason: string }) =>
  adminPost<{ gift: { plan: { code: string; name: string }; days: number; expires_at: string } }>(
    `/accounts/${encodeURIComponent(id)}/gift-plan`, gift,
  )

export const fetchAdminPayments = (tab: AdminPaymentTab, page: number) =>
  request<AdminPayments>(`/admin/payments${adminQuery({ tab, page })}`)

export const confirmAdminPayment = (code: string, input: { amount_vnd?: number; reason: string }) =>
  adminPost<{ outcome: string; order: AdminOrder }>(`/payments/${encodeURIComponent(code)}/confirm`, input)

export const cancelAdminPayment = (code: string, reason: string) =>
  adminPost<{ order: AdminOrder }>(`/payments/${encodeURIComponent(code)}/cancel`, { reason })

export const fetchAdminAudit = (query: { page: number; action?: string; accountId?: string }) =>
  request<Page<AdminAuditItem>>(`/admin/audit${adminQuery({ page: query.page, action: query.action, account_id: query.accountId })}`)

export const fetchAdminAuditFor = (query: { page: number; staffId: string }) =>
  request<Page<AdminAuditItem>>(`/admin/audit${adminQuery({ page: query.page, staff_id: query.staffId })}`)

// Mock weather: for one account (live or mock mode, ends by itself), or, with
// WEATHER_MODE=mock on the Gateway, per province or 'all'.
export const fetchAdminWeather = () => request<AdminWeather>('/admin/weather')

export const setAdminWeatherMock = (area: string, mock: WeatherMock) =>
  request<{ mocks: Record<string, WeatherMock> }>('/admin/weather/mock', { method: 'PUT', body: JSON.stringify({ area, ...mock }) })

export const clearAdminWeatherMock = (area: string) =>
  request<{ mocks: Record<string, WeatherMock> }>(`/admin/weather/mock/${encodeURIComponent(area)}`, { method: 'DELETE' })

export const setAdminWeatherAccountMock = (body: WeatherMock & { email: string; hours: number }) =>
  request<{ accounts: WeatherAccountMock[] }>('/admin/weather/account-mock', { method: 'PUT', body: JSON.stringify(body) })

export const clearAdminWeatherAccountMock = (accountId: string) =>
  request<{ accounts: WeatherAccountMock[] }>(`/admin/weather/account-mock/${encodeURIComponent(accountId)}`, { method: 'DELETE' })

// ── Session and staff ──────────────────────────────────────────────────────

export interface SessionState {
  staff: Staff
  /** The Console is connected to a Simulator (SIMULATOR_TOKEN set). */
  simulator: boolean
}

/** Who is signed in; null when nobody (no cookie, expired, locked). */
export const fetchSession = async (): Promise<SessionState | null> => {
  try {
    return await request<SessionState>('/session')
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === 401) return null
    throw caught
  }
}

export const signIn = (email: string, password: string) =>
  request<{ staff: Staff }>('/session/login', { method: 'POST', body: JSON.stringify({ email, password }) })

export const signOut = () => request<{ success: boolean }>('/session/logout', { method: 'POST' })

export const changeOwnPassword = (currentPassword: string, newPassword: string) =>
  adminPost<{ success: boolean }>('/staff/me/password', { current_password: currentPassword, new_password: newPassword })

export const fetchOwnSessions = async (): Promise<OwnSession[]> =>
  (await request<{ sessions: OwnSession[] }>('/admin/staff/me/sessions')).sessions

export const revokeOtherOwnSessions = () =>
  adminPost<{ signed_out_sessions: number }>('/staff/me/sessions/revoke-others', {})

export const fetchPermissions = () =>
  request<{ permissions: PermissionInfo[]; presets: PermissionPreset[] }>('/admin/permissions')

export const fetchStaff = async (): Promise<StaffMember[]> =>
  (await request<{ staff: StaffMember[] }>('/admin/staff')).staff

export const createStaff = (input: { email: string; full_name: string; permissions: string[] }) =>
  adminPost<{ staff: Staff; temporary_password: string }>('/staff', input)

export const updateStaff = (id: string, input: { full_name?: string; permissions?: string[] }) =>
  request<{ staff: Staff }>(`/admin/staff/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) })

export type StaffAction = 'disable' | 'enable' | 'reset-password' | 'sign-out'

export const actOnStaff = (id: string, action: StaffAction, reason: string) =>
  adminPost<{ signed_out_sessions: number; temporary_password?: string }>(
    `/staff/${encodeURIComponent(id)}/${action}`, { reason },
  )
