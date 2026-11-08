import type {
  CameraSegment,
  CameraStatus,
  CatalogProduct,
  DeviceDetailPayload,
  DeviceLivePayload,
  DeviceOperation,
  DevicePairing,
  DeviceStatePatch,
  FactoryBatch,
  FactoryDevice,
  Overview,
  Page,
  Preflight,
  RunConfig,
  SimulatedDevice,
  SimulatedUser,
  SimulationRun,
  SimulatorEvent,
} from './types'

const API_BASE = (import.meta.env.VITE_SIMULATOR_API_URL || '/api')
  .replace(/\/$/, '')
const TOKEN_KEY = 'device-simulator.admin-token'

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

export const getAdminToken = (): string => sessionStorage.getItem(TOKEN_KEY) || ''

export const setAdminToken = (token: string): void => {
  const normalized = token
    .trim()
    .replace(/^ADMIN_TOKEN\s*=\s*/i, '')
    .replace(/^Bearer\s+/i, '')
    .replace(/^["']|["']$/g, '')
    .trim()
  if (normalized) sessionStorage.setItem(TOKEN_KEY, normalized)
  else sessionStorage.removeItem(TOKEN_KEY)
}

const request = async <T>(
  path: string,
  init: RequestInit = {},
  acceptedErrorStatuses: readonly number[] = [],
): Promise<T> => {
  const token = getAdminToken()
  const hasBody = init.body !== undefined && init.body !== null
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  })
  const data = await response.json().catch(() => null) as {
    error?: string | { code?: string; message?: string }
  } | null
  if (!response.ok && !acceptedErrorStatuses.includes(response.status)) {
    const message = typeof data?.error === 'string'
      ? data.error
      : data?.error?.message || ([502, 504].includes(response.status)
        ? 'Web chưa kết nối được với backend simulator. Kiểm tra backend simulator và API Gateway đã khởi động; lỗi này chưa xác định token đúng hay sai.'
        : `Simulator API returned HTTP ${response.status}`)
    const code = typeof data?.error === 'object' ? data.error.code : undefined
    throw new ApiError(message, response.status, code)
  }
  return data as T
}

// A valid token can still produce 503 while one infrastructure dependency is
// unavailable. Preserve that response so the UI can show individual checks;
// authentication failures such as 401 still throw.
export const fetchPreflight = () => request<Preflight>('/preflight', {}, [503])

export const fetchRuns = async (): Promise<SimulationRun[]> =>
  (await request<{ runs: SimulationRun[] }>('/simulation-runs')).runs

export const fetchRun = async (id: string): Promise<SimulationRun> =>
  (await request<{ run: SimulationRun }>(`/simulation-runs/${encodeURIComponent(id)}`)).run

export const fetchOverview = () => request<Overview>('/overview')

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
  const result = await request<Omit<Page<SimulatedUser>, 'items'> & { users: SimulatedUser[] }>(`/users?${params}`)
  return { page: result.page, page_size: result.page_size, total: result.total, items: result.users }
}

export const fetchUser = async (accountId: string) =>
  request<{
    user: SimulatedUser
    devices: SimulatedDevice[]
    telemetry: Record<string, unknown>[]
    operations: DeviceOperation[]
  }>(
    `/users/${encodeURIComponent(accountId)}`,
  )

export const revealUserCredential = async (accountId: string) =>
  request<{ credential: { email: string; password: string } }>(
    `/users/${encodeURIComponent(accountId)}/reveal-credential`,
    { method: 'POST' },
  )

export const userAction = (
  accountId: string,
  action: 'relogin' | 'refresh-session' | 'make-permanent' | 'cleanup',
) => request(`/users/${encodeURIComponent(accountId)}/${action}`, { method: 'POST' })

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
  const result = await request<Omit<Page<SimulatedDevice>, 'items'> & { devices: SimulatedDevice[] }>(`/devices?${params}`)
  return { page: result.page, page_size: result.page_size, total: result.total, items: result.devices }
}

export const fetchDevice = async (mac: string) =>
  request<DeviceDetailPayload>(`/devices/${encodeURIComponent(mac)}`)

export const fetchDeviceLive = async (mac: string) =>
  request<DeviceLivePayload>(`/devices/${encodeURIComponent(mac)}/live`)

export const setDeviceConnection = (mac: string, online: boolean) =>
  request(`/devices/${encodeURIComponent(mac)}/${online ? 'connect' : 'disconnect'}`, {
    method: 'POST',
  })

export const sendDeviceTelemetry = (mac: string) =>
  request(`/devices/${encodeURIComponent(mac)}/telemetry`, { method: 'POST' })

export const deviceAction = (
  mac: string,
  action: 'pause' | 'resume' | 'force-offline' | 'reconnect' | 'reset-state',
) => request(`/devices/${encodeURIComponent(mac)}/${action}`, { method: 'POST' })

export const updateDeviceState = (
  mac: string,
  state: DeviceStatePatch,
) => request<{
  state: NonNullable<SimulatedDevice['state_snapshot']>
  delivery: 'publish_requested' | 'stored_offline'
}>(`/devices/${encodeURIComponent(mac)}/state`, {
  method: 'PATCH',
  body: JSON.stringify(state),
})

export const performPhysicalPumpAction = (mac: string, action: 'start' | 'stop') =>
  request<{ state: NonNullable<SimulatedDevice['state_snapshot']> }>(
    `/devices/${encodeURIComponent(mac)}/physical-pump`,
    { method: 'POST', body: JSON.stringify({ action }) },
  )

export const performPhysicalSirenAction = (
  mac: string,
  action: 'test_siren' | 'mute_siren' | 'resume_siren',
  durationSeconds = 0,
) => request<{
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
  request<{
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
) => request<{
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
  request<{ status: CameraStatus; segments: CameraSegment[] }>(`/devices/${encodeURIComponent(mac)}/camera`)

export const startCameraSource = (mac: string, body: {
  session_id: string
  force: boolean
  video: { codec: string; width: number; height: number; framerate: number; description: string }
  audio: { codec: 'mp4a.40.2'; sample_rate: number; channels: number; description?: string } | null
}) => request<{ status: CameraStatus }>(`/devices/${encodeURIComponent(mac)}/camera/source`, {
  method: 'POST',
  body: JSON.stringify({ action: 'start', ...body }),
})

export const stopCameraSource = (mac: string, sessionId: string) =>
  request<{ status: CameraStatus }>(`/devices/${encodeURIComponent(mac)}/camera/source`, {
    method: 'POST',
    body: JSON.stringify({ action: 'stop', session_id: sessionId }),
  })

export const sendCameraChunks = (mac: string, sessionId: string, body: Uint8Array) =>
  request<null>(
    `/devices/${encodeURIComponent(mac)}/camera/chunks?session_id=${encodeURIComponent(sessionId)}`,
    { method: 'POST', body: body as BodyInit, headers: { 'Content-Type': 'application/octet-stream' } },
  )

/** Downloads one recorded minute (fMP4) for local playback in the dashboard. */
export const fetchCameraSegment = async (mac: string, segmentId: string): Promise<Blob> => {
  const token = getAdminToken()
  const response = await fetch(
    `${API_BASE}/devices/${encodeURIComponent(mac)}/camera/segments/${encodeURIComponent(segmentId)}`,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} },
  )
  if (!response.ok) throw new ApiError(`Không tải được bản ghi (HTTP ${response.status})`, response.status)
  return response.blob()
}

/** QR label content of any simulated device (decrypts the factory secret). */
export const fetchDevicePairing = async (mac: string): Promise<DevicePairing> =>
  (await request<{ pairing: DevicePairing }>(`/devices/${encodeURIComponent(mac)}/pairing`)).pairing

export const fetchFactoryBatches = async () =>
  request<{ batches: FactoryBatch[]; max_batch_size: number }>('/factory/batches')

export const manufactureBatch = (body: {
  product_id: string
  quantity: number
  power_on: boolean
  note?: string
}) => request<{ batch: FactoryBatch; devices: FactoryDevice[] }>('/factory/batches', {
  method: 'POST',
  body: JSON.stringify(body),
})

export const fetchFactoryDevices = async (options: { batchId?: string; includePairing?: boolean } = {}) => {
  const params = new URLSearchParams()
  if (options.batchId) params.set('batch_id', options.batchId)
  if (options.includePairing) params.set('include_pairing', '1')
  return (await request<{ devices: FactoryDevice[] }>(`/factory/devices?${params}`)).devices
}

export const setFactoryPower = (mac: string, on: boolean) =>
  request<{ runtime_state: string }>(`/factory/devices/${encodeURIComponent(mac)}/power`, {
    method: 'POST',
    body: JSON.stringify({ on }),
  })

export const scrapFactoryDevice = (mac: string) =>
  request(`/factory/devices/${encodeURIComponent(mac)}/scrap`, { method: 'POST' })

export const scrapUnclaimedBatch = (batchId: string) =>
  request<{ scrapped: number; kept: number }>(
    `/factory/batches/${encodeURIComponent(batchId)}/scrap-unclaimed`,
    { method: 'POST' },
  )

export const createRun = (config: RunConfig) =>
  request<{ run_id: string; status: RunStatus }>('/simulation-runs', {
    method: 'POST',
    body: JSON.stringify(config),
  })

export const runAction = (
  id: string,
  action: 'pause' | 'resume' | 'cancel' | 'cleanup' | 'stop-runtime' | 'restart-runtime',
) => request(`/simulation-runs/${encodeURIComponent(id)}/${action}`, { method: 'POST' })

export const setRunPermanent = (id: string, permanent: boolean) =>
  request(`/simulation-runs/${encodeURIComponent(id)}/retention`, {
    method: 'POST',
    body: JSON.stringify({ policy: permanent ? 'permanent' : 'auto_24h' }),
  })

export const fetchEvents = async (options: { runId?: string; problemsOnly?: boolean } = {}): Promise<SimulatorEvent[]> => {
  const params = new URLSearchParams()
  if (options.runId) params.set('run_id', options.runId)
  if (options.problemsOnly) params.set('severity', 'warning')
  return (await request<{ events: SimulatorEvent[] }>(`/events?${params}`)).events
}

export const fetchCatalog = async (): Promise<CatalogProduct[]> =>
  (await request<{ products: CatalogProduct[] }>('/catalog/products')).products

export const subscribeStream = (
  onEvent: (event: SimulatorEvent) => void,
  onError?: (error: Error) => void,
): (() => void) => {
  const controller = new AbortController()
  const connect = async () => {
    let retryMs = 1000
    while (!controller.signal.aborted) {
      try {
        const token = getAdminToken()
        const response = await fetch(`${API_BASE}/events/stream`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: controller.signal,
        })
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
