import type { SimulationRun } from '../domain/simulation-run';
import { env } from '../config/env';

/** Registry scope of every device manufactured by the simulator factory. */
export const FACTORY_RUN_ID = 'factory';

/**
 * Content of the QR label printed on a device. The SmartHome app scans it and
 * calls `POST /devices/claim` with these two values (DeviceQrPayload in the
 * Flutter app); nothing else is needed to claim a factory device.
 */
export interface DevicePairingPayload {
    type: 'smarthome-device';
    version: 1;
    mac: string;
    secret_key: string;
}

export const buildPairingPayload = (mac: string, secretKey: string): DevicePairingPayload => ({
    type: 'smarthome-device',
    version: 1,
    mac: mac.trim().toUpperCase(),
    secret_key: secretKey,
});

/** Compact JSON keeps the QR symbol small enough for a 2 cm label. */
export const encodePairingPayload = (payload: DevicePairingPayload): string => JSON.stringify(payload);

const PRODUCT_CODES: Record<string, string> = {
    prod_security_camera: 'CAM',
    prod_entrance_controller: 'ENT',
    prod_hazard_mitigation: 'HAZ',
    prod_irrigation_manager: 'IRR',
    prod_roof_controller: 'ROF',
};

/** Three-letter product code printed in serial numbers. */
export const productSerialCode = (productId: string): string => {
    const known = PRODUCT_CODES[productId];
    if (known) return known;
    const letters = productId.replace(/^prod_/, '').replace(/[^a-z]/gi, '').toUpperCase();
    return (letters + 'XXX').slice(0, 3);
};

const twoDigits = (value: number): string => String(value).padStart(2, '0');

/** SX-CAM-2611-0007: brand, product, production year+month, factory-wide sequence. */
export const formatSerialNumber = (productId: string, manufacturedAt: Date, sequence: number): string => (
    `SX-${productSerialCode(productId)}-${twoDigits(manufacturedAt.getUTCFullYear() % 100)}`
    + `${twoDigits(manufacturedAt.getUTCMonth() + 1)}-${String(sequence).padStart(4, '0')}`
);

/** LOT-261107-003: production date and the factory-wide lot sequence. */
export const formatBatchId = (manufacturedAt: Date, sequence: number): string => (
    `LOT-${twoDigits(manufacturedAt.getUTCFullYear() % 100)}${twoDigits(manufacturedAt.getUTCMonth() + 1)}`
    + `${twoDigits(manufacturedAt.getUTCDate())}-${String(sequence).padStart(3, '0')}`
);

/**
 * Factory devices are not part of a simulation run. Their firmware still needs
 * the telemetry settings a run would supply, so the factory provides a fixed
 * run-shaped context that is never stored in `simulation_runs`.
 */
export const factoryRunContext = (): SimulationRun => {
    const now = new Date(0);
    return {
        id: FACTORY_RUN_ID,
        status: 'running',
        config: {
            user_count: 0,
            email_prefix: 'factory',
            email_domain: 'factory.invalid',
            devices_min: 0,
            devices_max: 0,
            networks_min: 1,
            networks_max: 1,
            products: [],
            telemetry_interval: env.FACTORY_TELEMETRY_INTERVAL_SECONDS,
            telemetry_jitter_percent: 10,
            startup_ramp_seconds: 3,
            initial_offline_rate: 0,
            cleanup_policy: 'manual',
            auto_start: true,
        },
        progress: {
            users_requested: 0,
            users_created: 0,
            devices_requested: 0,
            devices_provisioned: 0,
            devices_claimed: 0,
        },
        metrics: {
            totals: {
                telemetry_published: 0,
                telemetry_failed: 0,
                telemetry_bytes: 0,
                operations_received: 0,
                operations_applied: 0,
                operations_rejected: 0,
                acks_published: 0,
                acks_failed: 0,
                mqtt_connects: 0,
                mqtt_disconnects: 0,
                mqtt_errors: 0,
            },
        },
        total_errors: 0,
        cleanup_retries: 0,
        created_at: now,
        updated_at: now,
    };
};
