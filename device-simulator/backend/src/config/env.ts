import dotenv from 'dotenv';
import path from 'node:path';
import { z } from 'zod';

dotenv.config({
    path: [
        path.resolve(__dirname, '../../.env'),
        path.resolve(__dirname, '../../../.env'),
    ],
    quiet: true,
});

const booleanValue = (defaultValue: boolean) =>
    z.enum(['true', 'false']).default(String(defaultValue) as 'true' | 'false')
        .transform((value) => value === 'true');

const optionalString = z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().optional(),
);

const envSchema = z.object({
    PORT: z.coerce.number().int().min(1).max(65535).default(4001),
    HOST: z.string().default('0.0.0.0'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

    SIMULATOR_ENABLED: booleanValue(false),
    ALLOW_PRODUCTION_SIMULATOR: booleanValue(false),
    ADMIN_TOKEN: z.string().min(16),
    ADMIN_CORS_ORIGINS: z.string().default('http://localhost:4000,http://localhost:5173'),
    CREDENTIAL_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/, 'must be a 32-byte hex key'),

    API_GATEWAY_URL: z.string().url(),
    API_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),
    REGISTRATION_DELAY_MS: z.coerce.number().int().min(0).max(120000).default(12500),
    CLAIM_DELAY_MS: z.coerce.number().int().min(0).max(120000).default(6500),
    MAX_USERS_PER_RUN: z.coerce.number().int().min(1).max(100000).default(10000),
    MAX_DEVICES_PER_RUN: z.coerce.number().int().min(1).max(1000000).default(10000),
    MAX_ACTIVE_DEVICES: z.coerce.number().int().min(1).max(1000000).default(10000),
    MAX_TELEMETRY_MESSAGES_PER_SECOND: z.coerce.number().positive().max(1000000).default(1000),
    TELEMETRY_PUBLISH_CONCURRENCY: z.coerce.number().int().min(1).max(10000).default(100),
    METRICS_FLUSH_INTERVAL_MS: z.coerce.number().int().min(250).max(60000).default(1000),
    METRICS_RATE_WINDOW_SECONDS: z.coerce.number().int().min(10).max(300).default(60),
    REGISTRY_STATE_FLUSH_INTERVAL_MS: z.coerce.number().int().min(1000).max(60000).default(5000),

    POSTGRES_USER: z.string(),
    POSTGRES_PASSWORD: z.string(),
    POSTGRES_DB: z.string(),
    POSTGRES_HOST: z.string(),
    POSTGRES_PORT: z.coerce.number().int().min(1).max(65535).default(5432),

    MONGODB_URI: z.string().url(),
    SIMULATOR_MONGO_DB_NAME: z.string().default('DeviceSimulatorDB'),
    MAIN_MONGODB_URI: optionalString,
    MAIN_MONGO_DB_NAME: z.string().default('SmartHomeDB'),
    MAIN_MONGO_DEVICE_SHADOWS_COLLECTION: z.string().default('device_shadows'),
    MAIN_MONGO_TELEMETRY_COLLECTION: z.string().default('device_telemetry'),
    MAIN_MONGO_INGEST_RECEIPTS_COLLECTION: z.string().default('telemetry_ingest_receipts'),

    MQTT_HOST: z.string(),
    MQTT_PORT: z.coerce.number().int().min(1).max(65535).default(1883),
    MQTT_USERNAME: optionalString,
    MQTT_PASSWORD: optionalString,
    MQTT_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
    MQTT_CONTROL_TOPIC: z.string().default('smarthome/{device_id}/control'),
    MQTT_HUB_CONTROL_TOPIC: z.string().default('smarthome/{hub_id}/hub/control'),
    MQTT_TELEMETRY_TOPIC: z.string().default('smarthome/{device_id}/telemetry'),
    MQTT_ACK_TOPIC: z.string().default('smarthome/{device_id}/ack'),
    MQTT_STATUS_TOPIC: z.string().default('smarthome/{device_id}/status'),
    MQTT_TOPOLOGY_TOPIC: z.string().default('smarthome/{device_id}/topology'),
    MQTT_TOPOLOGY_ACK_TOPIC: z.string().default('smarthome/{device_id}/topology/ack'),
    OPERATION_DEDUP_TTL_MS: z.coerce.number().int().min(1000).max(24 * 60 * 60 * 1000)
        .default(10 * 60 * 1000),

    CLEANUP_INTERVAL_MS: z.coerce.number().int().min(10000).default(15 * 60 * 1000),
    CLEANUP_RETENTION_HOURS: z.coerce.number().int().min(1).max(24 * 365).default(24),
    EVENT_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(7),
    MAX_PAGE_SIZE: z.coerce.number().int().min(10).max(1000).default(200),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
    const issues = parsedEnv.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
    }));
    console.error('Invalid device-simulator environment variables:', issues);
    throw new Error('Invalid device-simulator environment configuration');
}

if (
    parsedEnv.data.NODE_ENV === 'production'
    && (!parsedEnv.data.SIMULATOR_ENABLED || !parsedEnv.data.ALLOW_PRODUCTION_SIMULATOR)
) {
    throw new Error(
        'Production simulator startup requires both SIMULATOR_ENABLED=true and ALLOW_PRODUCTION_SIMULATOR=true',
    );
}

export const env = parsedEnv.data;
export type SimulatorEnv = typeof env;
