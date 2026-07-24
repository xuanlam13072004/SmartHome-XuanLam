export type RunStatus = 'queued' | 'running' | 'paused' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'cleaning' | 'cleaned' | 'cleanup_blocked';

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
    random_seed?: string;
    concurrency: number;
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

export interface SimulationRun {
    _id?: string;
    id: string;
    status: RunStatus;
    config: SimulationRunConfig;
    progress: SimulationRunProgress;
    total_errors: number;
    last_error?: string;
    started_at?: Date;
    completed_at?: Date;
    cleanup_after?: Date;
    cleanup_retries: number;
    last_cleanup_error?: string;
    created_at: Date;
    updated_at: Date;
}
