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
    | 'cleanup_blocked';

export interface ProductWeight {
    product_id: string;
    weight: number; // Percentage, e.g., 50 for 50%
}

export interface SimulationRunConfig {
    user_count: number;
    username_prefix: string;
    email_domain: string;
    devices_min: number;
    devices_max: number;
    products: ProductWeight[];
    telemetry_interval: number;
    telemetry_jitter_percent: number;
    startup_ramp_seconds: number;
    random_seed?: string;
    initial_offline_rate: number;
    cleanup_policy: 'manual' | 'auto_24h';
    auto_start: boolean;
}

export interface SimulationRunProgress {
    users_requested: number;
    users_created: number;
    devices_requested: number;
    devices_provisioned: number;
    devices_claimed: number;
}

export interface SimulationRunMetricTotals {
    telemetry_published: number;
    telemetry_failed: number;
    telemetry_bytes: number;
    commands_received: number;
    commands_applied: number;
    commands_rejected: number;
    acks_published: number;
    acks_failed: number;
    mqtt_connects: number;
    mqtt_disconnects: number;
    mqtt_errors: number;
}

export interface SimulationRunMetrics {
    totals: SimulationRunMetricTotals;
    last_activity_at?: Date;
}

export interface SimulationRun {
    id: string;
    status: RunStatus;
    config: SimulationRunConfig;
    progress: SimulationRunProgress;
    metrics: SimulationRunMetrics;
    total_errors: number;
    last_error?: string | null;
    started_at?: Date;
    completed_at?: Date;
    cleanup_after?: Date;
    cleanup_retries: number;
    last_cleanup_error?: string | null;
    created_at: Date;
    updated_at: Date;
}
