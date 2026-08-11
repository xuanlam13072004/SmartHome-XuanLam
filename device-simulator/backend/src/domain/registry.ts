import type { DeviceState } from '../generation/telemetry-generator';
import type { EncryptedAuthSession } from '../security/auth-session';

export type RetentionPolicy = 'ttl' | 'permanent';
export type UserGenerationState = 'planned' | 'registered' | 'provisioning' | 'ready' | 'failed';
export type DeviceProvisioningState = 'planned' | 'provisioned' | 'claimed' | 'failed';
export type DeviceRuntimeState =
    | 'claimed'
    | 'connecting'
    | 'online'
    | 'paused'
    | 'offline'
    | 'stopped'
    | 'mqtt_error'
    | 'contract_error';
export type DeviceDesiredState = 'online' | 'offline';
export type TopologyRole = 'hub' | 'node';
export type TopologyState = 'stable' | 'degraded_direct' | 'electing' | 'empty';
export type TransportMode = 'hub' | 'relay' | 'direct_fallback';

export interface EncryptedValue {
    iv: string;
    encrypted: string;
    authTag: string;
}

export interface SimulatedUserRecord {
    run_id: string;
    generation_index: number;
    account_id?: string;
    account_created_by_simulator?: boolean;
    account_provenance?: 'registered' | 'recovered_after_register';
    email: string;
    full_name: string;
    credential: EncryptedValue;
    auth_session?: EncryptedAuthSession;
    target_device_count: number;
    generation_state: UserGenerationState;
    status: 'active' | 'failed';
    retention_policy: RetentionPolicy;
    expires_at?: Date;
    last_error?: string | null;
    created_at: Date;
    updated_at: Date;
}

export interface SimulatedDeviceRecord {
    run_id: string;
    simulator_user_id: string;
    generation_index: number;
    mac: string;
    device_id?: string;
    name: string;
    product_id: string;
    catalog_revision?: number;
    simulated_network_index: number;
    network_fingerprint: string;
    network_id?: string;
    join_rank?: number;
    topology_role?: TopologyRole;
    topology_epoch?: number;
    topology_state?: TopologyState;
    active_hub_mac?: string | null;
    transport_mode?: TransportMode;
    secret: EncryptedValue;
    credential_private_key: EncryptedValue;
    credential_public_key_pem: string;
    factory_owned: boolean;
    provisioning_state: DeviceProvisioningState;
    runtime_state: DeviceRuntimeState;
    desired_state: DeviceDesiredState;
    seq: number;
    state_snapshot?: DeviceState;
    retention_policy: RetentionPolicy;
    expires_at?: Date;
    last_error?: string | null;
    last_telemetry?: Date;
    created_at: Date;
    updated_at: Date;
}

export interface SimulatorEventRecord {
    type: string;
    severity: 'debug' | 'info' | 'warning' | 'error';
    run_id?: string;
    account_id?: string;
    mac?: string;
    message: string;
    data?: Record<string, unknown>;
    created_at: Date;
    expires_at: Date;
}
