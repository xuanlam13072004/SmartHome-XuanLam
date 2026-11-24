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

export interface SimulatedUser {
  run_id: string
  generation_index: number
  account_id?: string
  account_created_by_simulator?: boolean
  account_provenance?: 'registered' | 'recovered_after_register'
  email: string
  full_name: string
  target_device_count: number
  created_device_count?: number
  claimed_device_count?: number
  last_error?: string | null
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
  /** `factory`: manufactured blank by the simulator factory. Absent means `run`. */
  origin?: 'run' | 'factory'
  factory_batch_id?: string
  serial_number?: string
  claimed_at?: string
  /** Email of the simulated owner (paged registry list only). */
  owner_email?: string | null
  generation_index: number
  mac: string
  device_id?: string
  name: string
  product_id: string
  catalog_revision?: number
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
  last_error?: string | null
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

export interface DeviceEventRecord {
  _id?: string
  event_id: string
  device_id: string
  capability_id: string
  instance_id: string
  event_name: string
  severity: 'debug' | 'info' | 'warning' | 'error' | 'critical'
  data: Record<string, unknown>
  occurred_at: string
  received_at: string
  transport?: Record<string, unknown>
}

export interface EntranceRuntimeStatus {
  phase:
    | 'idle'
    | 'pin_entry'
    | 'unlocking'
    | 'unlocked_wait_open'
    | 'door_open'
    | 'closed_wait_relock'
    | 'locking'
    | 'sensor_fault'
    | 'pin_locked_out'
  attempts_remaining: number
  lockout_until?: string
  pending_lock_reason?: string
}

export interface VirtualHardwareDetail {
  access_pin: string
  entrance: EntranceRuntimeStatus | null
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
  state_authority?: 'device_firmware' | 'backend_intent' | 'product_catalog'
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
  product_contract_compatible: boolean
  backend_shadow: Record<string, unknown> | null
  telemetry: Record<string, unknown>[]
  operations: DeviceOperation[]
  events: SimulatorEvent[]
  device_events: DeviceEventRecord[]
  virtual_hardware: VirtualHardwareDetail | null
}

export interface DeviceLivePayload {
  device: SimulatedDevice
  backend_shadow: Record<string, unknown> | null
  latest_telemetry: Record<string, unknown> | null
  entrance: EntranceRuntimeStatus | null
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

export interface CameraStatus {
  source_active: boolean
  session_id: string | null
  video_resolution: string | null
  audio: boolean
  recording: boolean
  generation: string | null
  storage: {
    used_bytes: number
    total_bytes: number
    store_used_bytes: number
    segments: number
    oldest_recording_at: string | null
    newest_recording_at: string | null
  }
  last_error: string | null
}

export interface CameraSegment {
  id: string
  start: string
  end: string
  size: number
}

export interface DeviceOwner {
  device_id: string
  device_name: string
  account_email: string | null
  claimed_at: string | null
}

export interface FactoryBatch {
  id: string
  product_id: string
  catalog_revision: number
  quantity: number
  power_on: boolean
  note?: string
  created_at: string
  in_stock: number
  claimed: number
  powered_on: number
}

export interface FactoryDevice {
  mac: string
  serial_number: string | null
  name: string
  product_id: string
  catalog_revision: number | null
  factory_batch_id: string | null
  provisioning_state: string
  runtime_state: string
  desired_state: 'online' | 'offline'
  created_at: string
  owner: DeviceOwner | null
  pairing_payload?: string
}

export interface DevicePairing {
  mac: string
  serial_number: string | null
  product_id: string
  origin: 'run' | 'factory'
  payload: string
  claimable: boolean
  owner: DeviceOwner | null
}

export interface Page<T> {
  page: number
  page_size: number
  total: number
  items: T[]
}

export interface Overview {
  sampled_at: string
  process: {
    cpu_percent: number
    rss_bytes: number
    heap_used_bytes: number
    event_loop_delay_p99_ms: number
    uptime_seconds: number
  }
  runtime: {
    registered: number
    connected: number
    broker_connected: number
    paused: number
    awaiting_claim: number
    scheduler_due: number
    registry_pending_writes: number
  }
  rates: {
    window_seconds: number
    telemetry_per_second: number
    telemetry_failures_per_minute: number
    bytes_per_second: number
    operations_per_second: number
  }
  registry: {
    devices_total: number
    devices_by_state: Record<string, number>
    users_total: number
    active_runs: number
  }
  ingest_latency: {
    samples: number
    p50_ms: number
    p95_ms: number
    max_ms: number
  } | null
  limits: {
    gateway_register_per_minute: number
    gateway_login_per_minute: number
    gateway_claim_per_account_per_minute: number
    generation_concurrency: number
    max_users_per_run: number
    max_devices_per_run: number
    max_active_devices: number
    max_telemetry_messages_per_second: number
  }
}

// ── End-to-end probes (docs/architecture/load-testing.md) ──────────────────

export type ProbeKind = 'commands' | 'app_reads'

export interface ProbeParams {
  kind: ProbeKind
  users: number
  per_user: number
  concurrency: number
}

export interface LatencyStats {
  count: number
  mean_ms: number
  p50_ms: number
  p90_ms: number
  p95_ms: number
  p99_ms: number
  max_ms: number
}

export interface ProbeResult {
  id: string
  params: ProbeParams
  status: 'preparing' | 'running' | 'completed' | 'stopped' | 'failed'
  started_at: string
  finished_at: string | null
  context: Record<string, number>
  machine: { cpus: number; cpu_model: string; memory_gb: number; platform: string }
  users_used: number
  totals: { requests: number; ok: number; failed: number }
  latency: LatencyStats | null
  server: LatencyStats | null
  throughput_per_second: number
  errors: Record<string, number>
  note: string | null
}

export interface ProbeList {
  current: ProbeResult | null
  results: ProbeResult[]
  limits: { users: number; per_user: number; concurrency: number }
}

// ── Administration ("Quản trị", docs/architecture/admin.md) ─────────────────

export interface AdminOverview {
  generated_at: string
  accounts: { total: number; disabled: number; new_today: number; new_7d: number; active_7d: number }
  devices: { total: number; online: number; by_product: Array<{ product_id: string; name: string; count: number }> }
  plans: Array<{ code: string; name: string; count: number }>
  payments: {
    mode: 'off' | 'mock' | 'bank'
    revenue_month_vnd: number
    paid_orders_month: number
    mock_orders_month: number
    review: number
    pending: number
    unmatched_30d: number
    sepay_used: number
    sepay_limit: number
  }
  assistant: { tokens_month: number; requests_month: number; tokens_today: number; daily_cap: number }
  daily: { days: string[]; new_accounts: number[]; revenue_vnd: number[]; assistant_tokens: number[] }
}

export type AccountStatus = 'active' | 'disabled' | 'pending_deletion'

export interface AdminPlanRef {
  code: string
  name: string
}

export interface AdminAccountRow {
  id: string
  email: string
  full_name: string
  status: AccountStatus
  created_at: string
  plan: AdminPlanRef & { expires_at: string | null }
  owned_devices: number
  last_seen_at: string | null
}

export type AdminAccountFilter = 'all' | 'disabled' | 'paid'

export interface AdminOrder {
  code: string
  account?: { id: string; email: string }
  plan: AdminPlanRef
  months: number
  amount_vnd: number
  received_vnd: number
  status: 'pending' | 'expired' | 'review' | 'paid' | 'cancelled'
  paid_via: 'sepay' | 'manual' | 'mock' | null
  created_at: string | null
  expires_at?: string | null
  paid_at: string | null
  plan_expires_at?: string | null
}

export interface AdminAuditItem {
  id: number
  /** 'staff' with who, 'cli' (tools in the Gateway container), 'admin' (before staff accounts). */
  actor: { kind: string; id?: string | null; email?: string | null; name?: string | null }
  action: string
  account: { id: string | null; email: string | null } | null
  reason: string
  details: Record<string, unknown>
  created_at: string
}

export interface AdminAccountDetail {
  account: { id: string; email: string; full_name: string; status: AccountStatus; created_at: string; updated_at: string }
  plan: AdminPlanRef & { monthly_tokens: number; expires_at: string | null; used_tokens: number; requests: number }
  smart_features: { scenes: number; schedules: number; automations: number }
  devices: Array<{ mac: string; name: string; product: string; role: string; since: string; online: boolean; last_seen: string | null }>
  sessions: Array<{ id: string; platform: string; name: string | null; created_at: string; last_used_at: string; expires_at: string }>
  orders: AdminOrder[]
  /** Null without the audit.view permission. */
  admin_log: AdminAuditItem[] | null
}

export interface AdminGiftablePlan extends AdminPlanRef {
  monthly_tokens: number
  price_vnd: number
}

export type AdminPaymentTab = 'review' | 'pending' | 'paid' | 'unmatched'

export interface AdminTransfer {
  id: string
  provider: string
  reference: string
  amount_vnd: number
  content: string
  outcome: 'unmatched' | 'already_paid'
  order_code: string | null
  transferred_at: string | null
  received_at: string
}

export interface AdminPayments extends Page<AdminOrder | AdminTransfer> {
  mode: 'off' | 'mock' | 'bank'
  counts: { review: number; pending: number; unmatched: number }
  sepay: { used: number; limit: number }
  tab: AdminPaymentTab
}

export type AssistantOutcome = 'chat' | 'action' | 'clarify' | 'confirm' | 'refused' | 'error'

export interface AdminAssistant {
  generated_at: string
  period: string
  tokens_today: number
  daily_cap: number
  by_plan: Array<AdminPlanRef & { monthly_tokens: number; accounts: number; tokens: number; requests: number }>
  top: Array<{
    account_id: string
    email: string
    full_name: string
    status: AccountStatus
    plan: AdminPlanRef
    tokens: number
    requests: number
    monthly_tokens: number
  }>
  daily: { days: string[]; outcomes: Record<AssistantOutcome, number[]>; tokens: number[] }
  channels: Partial<Record<'voice' | 'text', number>>
}

// ── Staff of the Admin Console ─────────────────────────────────────────────

export interface Staff {
  id: string
  email: string
  full_name: string
  is_root: boolean
  permissions: string[]
  must_change_password: boolean
}

export interface StaffMember extends Staff {
  status: 'active' | 'disabled'
  locked: boolean
  last_login_at: string | null
  created_at: string
  sessions: number
}

export interface PermissionInfo {
  code: string
  group: string
  label: string
  implies?: string[]
}

export interface PermissionPreset {
  code: string
  name: string
  permissions: string[]
}

// ── Mock weather ───────────────────────────────────────────────────────────

export type WeatherScenario = 'sunny' | 'rain_soon' | 'raining' | 'heat'

export interface WeatherMock {
  scenario: WeatherScenario
  /** °C now; each scenario has its own default. */
  temperature?: number
  /** rain_soon: hours until it rains (1–12). */
  rain_in_hours?: number
}

export interface AdminWeather {
  mode: 'off' | 'live' | 'mock'
  provinces: Array<{ code: string; name: string }>
  /** 'all' or a province code → what is played there. */
  mocks: Record<string, WeatherMock>
}

export interface OwnSession {
  id: string
  client: string | null
  ip: string | null
  created_at: string
  last_used_at: string
  expires_at: string
  current: boolean
}
