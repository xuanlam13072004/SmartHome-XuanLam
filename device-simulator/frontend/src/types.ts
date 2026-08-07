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
  email_prefix: string
  email_domain: string
  devices_min: number
  devices_max: number
  networks_min: number
  networks_max: number
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
    operations_received: number
    operations_applied: number
    operations_rejected: number
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
    operations_per_second: number
  }
  runtime: {
    registered: number
    connected: number
    broker_connected: number
    relay_connected: number
    direct_fallback_connected: number
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
  account_provenance?: 'registered' | 'recovered_after_register'
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

export interface DeviceOperation {
  id: string
  mac: string
  status: string
  instance_id: string
  operation_name: string
  input: Record<string, unknown>
  risk: 'normal' | 'sensitive' | 'dangerous'
  reason_code?: string | null
  catalog_revision: number
  accepted_at: string
  completed_at?: string | null
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
  simulated_network_index: number
  network_fingerprint: string
  network_id?: string
  join_rank?: number
  topology_role?: 'hub' | 'node'
  topology_epoch?: number
  topology_state?: 'stable' | 'degraded_direct' | 'electing' | 'empty'
  active_hub_mac?: string | null
  transport_mode?: 'hub' | 'relay' | 'direct_fallback'
  provisioning_state: string
  runtime_state: string
  desired_state: 'online' | 'offline'
  seq: number
  state_snapshot?: {
    state_version: number
    instances: Record<string, {
      reported: Record<string, unknown>
      desired: Record<string, unknown>
    }>
    diagnostics: Record<string, Record<string, unknown>>
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
  description: string
  icon: string
  ui_profile: string
  capability_count: number
}

export interface ValueSchema {
  type: 'boolean' | 'number' | 'integer' | 'string' | 'array' | string
  nullable?: boolean
  enum?: unknown[]
  minimum?: number
  maximum?: number
  min_length?: number
  max_length?: number
  min_items?: number
  max_items?: number
  items?: ValueSchema
  default?: unknown
  unit?: string
  precision?: number
  required?: boolean
  presentation?: PresentationMetadata
}

export interface PresentationMetadata {
  display_name?: string
  label?: string
  description?: string
  icon?: string
  section?: string
  order?: number
  ui_hint?: string
  [key: string]: unknown
}

export interface CapabilityProperty extends ValueSchema {
  id: string
  channel: 'reported' | 'desired' | 'diagnostic'
  path: string
}

export interface CapabilityOperation {
  id: string
  input: Record<string, ValueSchema>
  permission: string
  risk: 'normal' | 'sensitive' | 'dangerous'
  presentation?: PresentationMetadata
}

export interface CapabilityEvent {
  id: string
  producer?: string
  severity?: string
  retention?: string
  data?: Record<string, ValueSchema>
  presentation?: PresentationMetadata
}

export interface CapabilityInstance {
  instance_id: string
  capability_id: string
  semantic_role?: string
  availability?: string
  presentation?: PresentationMetadata
  runtime?: Record<string, unknown>
  properties: CapabilityProperty[]
  operations: CapabilityOperation[]
  events: CapabilityEvent[]
  resources: Array<Record<string, unknown>>
}

export interface ProductContract {
  schema: 'compiled.product.v2'
  product_id: string
  catalog_revision: number
  model_name: string
  category: string
  description?: string
  ui_profile?: string
  presentation: PresentationMetadata
  capability_instances: CapabilityInstance[]
  local_policies?: Array<Record<string, unknown>>
}

export interface DeviceStatePatch {
  instances?: Record<string, {
    reported?: Record<string, unknown>
    desired?: Record<string, unknown>
  }>
  diagnostics?: Record<string, Record<string, unknown>>
}

export interface DeviceDetailPayload {
  device: SimulatedDevice
  product: ProductContract
  backend_shadow: Record<string, unknown> | null
  telemetry: Record<string, unknown>[]
  operations: DeviceOperation[]
  events: SimulatorEvent[]
}

export interface DeviceLivePayload {
  device: SimulatedDevice
  backend_shadow: Record<string, unknown> | null
  latest_telemetry: Record<string, unknown> | null
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
