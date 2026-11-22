import { z } from 'zod';

const envSchema = z.object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().positive().default(3000),
    // Proxies allowed to set X-Forwarded-For (Cloudflare Tunnel), see config/trustProxy.ts.
    TRUST_PROXY: z.string().default(''),

    JWT_SECRET: z.string().min(8),
    JWT_EXPIRES_IN: z.coerce.number().int().positive().default(900),
    REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(604800),
    // Signing in beyond this many active sessions signs out the least recently used one,
    // so sessions stay bounded even for accounts that log in from scripts.
    MAX_SESSIONS_PER_ACCOUNT: z.coerce.number().int().min(1).max(100).default(20),
    // Device sharing: members + pending invitations per device (owner excluded), invitation lifetime.
    MAX_DEVICE_MEMBERS: z.coerce.number().int().min(1).max(50).default(10),
    INVITE_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(168),
    // Rooms each account may create.
    MAX_ROOMS_PER_ACCOUNT: z.coerce.number().int().min(1).max(200).default(30),
    // Scenes ("Kịch bản"): per-account count, steps per scene, run history kept.
    MAX_SCENES_PER_ACCOUNT: z.coerce.number().int().min(1).max(500).default(50),
    MAX_SCENE_STEPS: z.coerce.number().int().min(1).max(20).default(10),
    SCENE_RUN_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    MAX_SCHEDULES_PER_SCENE: z.coerce.number().int().min(1).max(20).default(5),
    // Automations ("Tự động") per account; their notifications are kept this long.
    MAX_AUTOMATIONS_PER_ACCOUNT: z.coerce.number().int().min(1).max(200).default(30),
    ACCOUNT_NOTIFICATION_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    // Voice verification service (docs/architecture/voice.md). Without a token the
    // voice endpoints answer 503 VOICE_UNAVAILABLE.
    VOICE_SERVICE_URL: z.string().url().default('http://voice-service:8000'),
    VOICE_SERVICE_TOKEN: z.string().default(''),
    // Assistant (docs/architecture/assistant.md). Without a key the assistant answers 503.
    GEMINI_API_KEY: z.string().default(''),
    GEMINI_MODEL: z.string().regex(/^[a-z0-9.-]+$/).default('gemini-3.8-flash'),
    GEMINI_API_URL: z.string().url().default('https://generativelanguage.googleapis.com/v1beta'),
    // minimal | low | medium | high; empty sends no thinking setting (models without levels).
    GEMINI_THINKING_LEVEL: z.enum(['', 'minimal', 'low', 'medium', 'high']).default('low'),
    // Tokens per day for the whole system (protects the shared API key), assistant log retention.
    ASSISTANT_DAILY_TOKEN_CAP: z.coerce.number().int().positive().default(3000000),
    ASSISTANT_TURN_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    // Payments (docs/architecture/payments.md): off · mock (no real money, for testing) · bank (VietQR).
    PAYMENT_MODE: z.enum(['off', 'mock', 'bank']).default('off'),
    // Receiving account: NAPAS BIN of the bank (6 digits), account number, holder, bank name to show.
    PAYMENT_BANK_BIN: z.string().regex(/^(\d{6})?$/).default(''),
    PAYMENT_BANK_ACCOUNT: z.string().regex(/^[0-9A-Za-z]{0,19}$/).default(''),
    PAYMENT_ACCOUNT_NAME: z.string().max(50).default(''),
    PAYMENT_BANK_NAME: z.string().max(40).default(''),
    PAYMENT_ORDER_TTL_MINUTES: z.coerce.number().int().min(5).max(60).default(15),
    // SePay webhook authentication: HMAC secret (preferred) or API key; SePay FREE allows 50 transactions/month.
    SEPAY_WEBHOOK_SECRET: z.string().default(''),
    SEPAY_API_KEY: z.string().default(''),
    SEPAY_MONTHLY_LIMIT: z.coerce.number().int().positive().default(50),
    // Push notifications (docs/architecture/push.md): the Firebase service account JSON
    // (a secret kept out of the project); empty or missing file = push off.
    FCM_SERVICE_ACCOUNT_FILE: z.string().default(''),
    FCM_API_URL: z.string().url().default('https://fcm.googleapis.com'),
    // The same alert of the same device is pushed at most once in this window.
    PUSH_EVENT_THROTTLE_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),

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
    // Approximate cap per Redis Stream; durable state lives in PostgreSQL outboxes.
    REDIS_STREAM_MAXLEN: z.coerce.number().int().positive().default(100000),
    REDIS_CACHE_OWNER_PREFIX: z.string().default('owner_of:'),
    REDIS_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
    OPERATION_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(30),
    TOPOLOGY_ELECTION_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(30),
    TOPOLOGY_HUB_LEASE_SECONDS: z.coerce.number().int().positive().default(15),

    // Media relay (docs/architecture/camera-contract.md). PUBLIC is what apps open
    // (HLS over HTTPS); INGEST is what devices connect to. Unset = camera media
    // sessions are refused with MEDIA_RELAY_NOT_CONFIGURED.
    MEDIA_PUBLIC_URL: z.string().url().optional(),
    MEDIA_INGEST_URL: z.string().url().optional(),

    // Rate limits (requests per minute). Keyed by account/email/session, not IP,
    // except the coarse per-IP ceilings. Raise them in a load-test environment.
    RATE_LIMIT_REGISTER_PER_IP_PER_MINUTE: z.coerce.number().int().positive().default(20),
    RATE_LIMIT_LOGIN_PER_EMAIL_PER_MINUTE: z.coerce.number().int().positive().default(5),
    RATE_LIMIT_LOGIN_PER_IP_PER_MINUTE: z.coerce.number().int().positive().default(100),
    RATE_LIMIT_REFRESH_PER_SESSION_PER_MINUTE: z.coerce.number().int().positive().default(10),
    RATE_LIMIT_CLAIM_PER_ACCOUNT_PER_MINUTE: z.coerce.number().int().positive().default(10),
    RATE_LIMIT_OPERATIONS_PER_ACCOUNT_PER_MINUTE: z.coerce.number().int().positive().default(30),
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
