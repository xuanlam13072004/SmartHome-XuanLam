import type {
  CatalogProduct,
  Preflight,
  RunMetrics,
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
  const normalized = token.trim()
  if (normalized) sessionStorage.setItem(TOKEN_KEY, normalized)
  else sessionStorage.removeItem(TOKEN_KEY)
}

const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
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
  if (!response.ok) {
    const message = typeof data?.error === 'string'
      ? data.error
      : data?.error?.message || `Simulator API returned HTTP ${response.status}`
    const code = typeof data?.error === 'object' ? data.error.code : undefined
    throw new ApiError(message, response.status, code)
  }
  return data as T
}

export const fetchPreflight = () => request<Preflight>('/preflight')

export const fetchRuns = async (): Promise<SimulationRun[]> =>
  (await request<{ runs: SimulationRun[] }>('/simulation-runs')).runs

export const fetchRun = async (id: string): Promise<SimulationRun> =>
  (await request<{ run: SimulationRun }>(`/simulation-runs/${encodeURIComponent(id)}`)).run

export const fetchRunMetrics = async (id: string): Promise<RunMetrics> =>
  (await request<{ metrics: RunMetrics }>(
    `/simulation-runs/${encodeURIComponent(id)}/metrics`,
  )).metrics

export const fetchUsers = async (runId?: string): Promise<SimulatedUser[]> => {
  const params = new URLSearchParams()
  if (runId) params.set('run_id', runId)
  return (await request<{ users: SimulatedUser[] }>(`/users?${params}`)).users
}

export const fetchUser = async (accountId: string) =>
  request<{ user: SimulatedUser; devices: SimulatedDevice[] }>(
    `/users/${encodeURIComponent(accountId)}`,
  )

export const revealUserCredential = async (accountId: string) =>
  request<{ credential: { email: string; username: string; password: string } }>(
    `/users/${encodeURIComponent(accountId)}/reveal-credential`,
    { method: 'POST' },
  )

export const fetchDevices = async (
  runId?: string,
  userId?: string,
): Promise<SimulatedDevice[]> => {
  const params = new URLSearchParams()
  if (runId) params.set('run_id', runId)
  if (userId) params.set('user_id', userId)
  return (await request<{ devices: SimulatedDevice[] }>(`/devices?${params}`)).devices
}

export const fetchDevice = async (mac: string) =>
  request<{
    device: SimulatedDevice
    telemetry: Record<string, unknown>[]
    events: SimulatorEvent[]
  }>(`/devices/${encodeURIComponent(mac)}`)

export const setDeviceConnection = (mac: string, online: boolean) =>
  request(`/devices/${encodeURIComponent(mac)}/${online ? 'connect' : 'disconnect'}`, {
    method: 'POST',
  })

export const sendDeviceTelemetry = (mac: string) =>
  request(`/devices/${encodeURIComponent(mac)}/telemetry`, { method: 'POST' })

export const revealDeviceSecret = (mac: string) =>
  request<{ device: { mac: string; secret_key: string; product_id: string } }>(
    `/devices/${encodeURIComponent(mac)}/reveal-secret`,
    { method: 'POST' },
  )

export const createRun = (config: RunConfig) =>
  request<{ run_id: string; status: RunStatus }>('/simulation-runs', {
    method: 'POST',
    body: JSON.stringify(config),
  })

export const runAction = (
  id: string,
  action: 'pause' | 'resume' | 'cancel' | 'cleanup',
) => request(`/simulation-runs/${encodeURIComponent(id)}/${action}`, { method: 'POST' })

export const extendRun = (id: string, hours: number) =>
  request(`/simulation-runs/${encodeURIComponent(id)}/extend`, {
    method: 'POST',
    body: JSON.stringify({ hours }),
  })

export const setRunPermanent = (id: string, permanent: boolean) =>
  request(`/simulation-runs/${encodeURIComponent(id)}/retention`, {
    method: 'POST',
    body: JSON.stringify({ policy: permanent ? 'permanent' : 'auto_24h' }),
  })

export const fetchEvents = async (runId?: string): Promise<SimulatorEvent[]> => {
  const params = new URLSearchParams()
  if (runId) params.set('run_id', runId)
  return (await request<{ events: SimulatorEvent[] }>(`/events?${params}`)).events
}

export const fetchCatalog = async (): Promise<CatalogProduct[]> =>
  (await request<{ products: CatalogProduct[] }>('/catalog/products')).products

export const subscribeStream = (
  onEvent: (event: SimulatorEvent) => void,
  onError?: (error: Error) => void,
): (() => void) => {
  const controller = new AbortController()
  const token = getAdminToken()

  void fetch(`${API_BASE}/events/stream`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: controller.signal,
  }).then(async (response) => {
    if (!response.ok || !response.body) {
      throw new ApiError('Could not open simulator event stream', response.status)
    }
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
        const parsed = JSON.parse(dataLine.slice(6)) as SimulatorEvent
        if (parsed.type !== 'connected') onEvent(parsed)
      }
    }
  }).catch((error) => {
    if (!controller.signal.aborted) {
      onError?.(error instanceof Error ? error : new Error(String(error)))
    }
  })

  return () => controller.abort()
}

type RunStatus = SimulationRun['status']
