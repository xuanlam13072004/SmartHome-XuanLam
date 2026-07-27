export type RunStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'cleaning'
  | 'cleaned'
  | 'cleanup_failed'
  | 'cleanup_blocked'

export interface ProductWeight {
  product_id: string
  weight: number
}

export interface RunConfig {
  user_count: number
  username_prefix: string
  email_domain: string
  devices_min: number
  devices_max: number
  products: ProductWeight[]
  telemetry_interval: number
  random_seed?: string
  initial_offline_rate: number
  cleanup_policy: 'manual' | 'auto_24h'
  auto_start: boolean
}

export interface SimulationRun {
  id: string
  status: RunStatus
  config: RunConfig
  progress: {
    users_requested: number
    users_created: number
    devices_requested: number
    devices_provisioned: number
    devices_claimed: number
  }
  total_errors: number
  last_error?: string
  created_at: string
  updated_at: string
  started_at?: string
  completed_at?: string
  cleanup_after?: string
}

export interface SimulatedUser {
  run_id: string
  generation_index: number
  account_id?: string
  username: string
  email: string
  full_name: string
  target_device_count: number
  generation_state: string
  status: string
  retention_policy: 'ttl' | 'permanent'
  expires_at?: string
  created_at: string
  updated_at: string
}

export interface SimulatedDevice {
  run_id: string
  simulator_user_id: string
  generation_index: number
  mac: string
  device_id?: string
  name: string
  product_id: string
  provisioning_state: string
  runtime_state: string
  desired_state: 'online' | 'offline'
  seq: number
  state_snapshot?: {
    metrics: Record<string, unknown>
    diagnostics: Record<string, unknown>
  }
  retention_policy: 'ttl' | 'permanent'
  expires_at?: string
  last_telemetry?: string
  created_at: string
  updated_at: string
}

export interface SimulatorEvent {
  _id?: string
  type: string
  severity: 'debug' | 'info' | 'warning' | 'error'
  run_id?: string
  account_id?: string
  mac?: string
  message: string
  data?: Record<string, unknown>
  created_at: string
}

export interface CatalogProduct {
  id: string
  display_name: string
  category: string
  capability_count: number
}

export interface PreflightCheck {
  status: 'ok' | 'error'
  latency_ms: number
  message?: string
}

export interface Preflight {
  success: boolean
  enabled: boolean
  environment: string
  checks: Record<string, PreflightCheck>
}
