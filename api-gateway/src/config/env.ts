import { z } from 'zod';

const envSchema = z.object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().positive().default(3000),

    JWT_SECRET: z.string().min(8),
    JWT_EXPIRES_IN: z.coerce.number().int().positive().default(900),
    REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(604800),

    PG_HOST: z.string(),
    PG_PORT: z.coerce.number().int().positive().default(5432),
    PG_DATABASE: z.string(),
    PG_USER: z.string(),
    PG_PASSWORD: z.string(),
    PG_SSL: z.enum(['true', 'false']).transform(v => v === 'true').default('false'),

    MONGO_URI: z.string().url(),
    MONGO_DB_NAME: z.string().default('SmartHomeDB'),
    MONGO_DEVICE_SHADOWS_COLLECTION: z.string().default('device_shadows'),
    MONGO_ACTIVE_OPERATIONS_COLLECTION: z.string().default('active_operations'),
    MONGO_DEVICE_TELEMETRY_COLLECTION: z.string().default('device_telemetry'),
    MONGO_DEVICE_EVENTS_COLLECTION: z.string().default('device_events'),
    MONGO_DEVICE_INCIDENTS_COLLECTION: z.string().default('device_incidents'),
    MONGO_INGEST_RECEIPTS_COLLECTION: z.string().default('telemetry_ingest_receipts'),

    REDIS_URL: z.string().url(),
    REDIS_OPERATION_STREAM: z.string().default('device.operations'),
    REDIS_OPERATION_STATUS_STREAM: z.string().default('operation.status.stream'),
    REDIS_CREDENTIAL_STREAM: z.string().default('device.credentials'),
    REDIS_CREDENTIAL_STATUS_STREAM: z.string().default('credential.status.stream'),
    REDIS_CACHE_OWNER_PREFIX: z.string().default('owner_of:'),
    REDIS_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
    OPERATION_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(30),
    TOPOLOGY_ELECTION_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(30),
    TOPOLOGY_HUB_LEASE_SECONDS: z.coerce.number().int().positive().default(15),
});

const parseResult = envSchema.safeParse(process.env);

if (!parseResult.success) {
    console.error('❌ Environment validation failed:');
    parseResult.error.errors.forEach(err => {
        console.error(`  ${err.path.join('.')}: ${err.message}`);
    });
    process.exit(1);
}

export const env = parseResult.data;
