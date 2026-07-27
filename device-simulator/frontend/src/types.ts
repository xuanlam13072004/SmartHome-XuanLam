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
  telemetry_jitter_percent: number
  startup_ramp_seconds: number
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

export interface RunMetrics {
  run_id: string
  sampled_at: string
  totals: {
    telemetry_published: number
    telemetry_failed: number
    telemetry_bytes: number
    commands_received: number
    commands_applied: number
    commands_rejected: number
    acks_published: number
    acks_failed: number
    mqtt_connects: number
    mqtt_disconnects: number
    mqtt_errors: number
  }
  rates: {
    window_seconds: number
    telemetry_per_second: number
    telemetry_failures_per_minute: number
    bytes_per_second: number
    commands_per_second: number
  }
  runtime: {
    registered: number
    connected: number
    paused: number
    scheduler_active: number
    scheduler_due: number
  }
  process: {
    rss_bytes: number
    heap_used_bytes: number
    uptime_seconds: number
  }
  last_activity_at?: string
}

export interface SimulatedUser {
  run_id: string
  generation_index: number
  account_id?: string
  account_created_by_simulator?: boolean
  account_provenance?: 'registered' | 'recovered_after_register' | 'verified_legacy'
  username: string
  email: string
  full_name: string
  target_device_count: number
  generation_state: string
  status: string
  retention_policy: 'ttl' | 'permanent'
  auth_session?: {
    session_id: string
    updated_at: string
  }
  expires_at?: string
  created_at: string
  updated_at: string
}

export interface DeviceCommand {
  id: string
  mac: string
  status: string
  command: Record<string, unknown>
  error_log?: string | null
  retry_count: number
  event_version: number
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
