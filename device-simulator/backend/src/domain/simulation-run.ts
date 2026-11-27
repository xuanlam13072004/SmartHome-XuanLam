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
    email_prefix: string;
    email_domain: string;
    devices_min: number;
    devices_max: number;
    networks_min: number;
    networks_max: number;
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
    operations_received: number;
    operations_applied: number;
    operations_rejected: number;
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

/**
 * A run cleanup works user by user in the background (cleanup/cronjob.ts):
 * unpair the user's devices, delete the account, retire the devices at the
 * factory, forget the records. A user that cannot be cleaned is skipped and
 * reported; the others are not held up.
 */
export interface CleanupProgress {
    users_total: number;
    users_done: number;
    /** Need a person (a device added with the app, a device owned by someone else). */
    users_blocked: number;
    /** Failed on errors three times; pressing "Dọn dữ liệu" again retries them. */
    users_failed: number;
    devices_total: number;
    devices_retired: number;
    started_at: Date;
    updated_at: Date;
    /** Users blocked or failed, with the reason (at most 50 kept). */
    blocked?: Array<{ account_id?: string; email: string; reason: string }>;
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
    /**
     * The cleanup in progress also removes users kept with "Giữ dữ liệu" (a cleanup
     * someone asked for); a scheduled one keeps them. Read again when an interrupted
     * cleanup resumes after a restart.
     */
    cleanup_includes_kept?: boolean;
    /** Progress of the cleanup in progress (or the last one), shown by the Console. */
    cleanup_progress?: CleanupProgress;
    last_cleanup_error?: string | null;
    created_at: Date;
    updated_at: Date;
}
