const { z } = require('zod');

/**
 * Tác dụng:
 * - Đọc toàn bộ biến môi trường từ process.env
 * - Validate schema để tránh lỗi runtime do config sai
 * - Export object config dùng trong code
 * 
 * Lý do dùng Zod:
 * - Giúp fail fast nếu thiếu hoặc sai kiểu biến
 * - Log rõ ràng lỗi gì để debug nhanh
 */

// Schema validation dùng Zod
const envSchema = z.object({
    // Service
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    SERVICE_NAME: z.string().default('mqtt-worker-service'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

    // Redis
    REDIS_URL: z.string().url().default('redis://localhost:6379'),
    REDIS_COMMAND_STREAM: z.string().default('device.commands'),
    REDIS_COMMAND_STATUS_STREAM: z.string().default('command.status.stream'),
    REDIS_COMMAND_GROUP: z.string().default('mqtt-worker-group'),
    REDIS_COMMAND_CONSUMER: z.string().default('worker-1'),
    REDIS_UPDATE_CHANNEL: z.string().default('device.updates'),
    REDIS_CACHE_OWNER_PREFIX: z.string().default('owner_of:'),
    REDIS_CACHE_DEVICE_PREFIX: z.string().default('device:'),
    REDIS_CACHE_TTL_SECONDS: z.coerce.number().positive().default(3600),
    REDIS_CLAIM_IDLE_MS: z.coerce.number().positive().default(60000),
    REDIS_CLAIM_COUNT: z.coerce.number().positive().default(50),
    REDIS_CLAIM_INTERVAL_MS: z.coerce.number().positive().default(5000),

    // MQTT
    MQTT_BROKER_URL: z.string().url().default('mqtt://localhost:1883'),
    MQTT_CLIENT_ID: z.string().default('mqtt-worker-service'),
    MQTT_USERNAME: z.string().optional().default(''),
    MQTT_PASSWORD: z.string().optional().default(''),
    MQTT_QOS: z.coerce.number().int().min(0).max(2).default(1),
    MQTT_SHARED_GROUP: z.string().optional().default(''),
    MQTT_CONTROL_TOPIC: z.string().default('smarthome/{device_id}/control'),
    MQTT_TELEMETRY_TOPIC: z.string().default('smarthome/+/telemetry'),
    MQTT_ACK_TOPIC: z.string().default('smarthome/+/ack'),
    MQTT_STATUS_TOPIC: z.string().default('smarthome/+/status'),


    // MongoDB
    MONGO_URI: z.string().url().default('mongodb://localhost:27017'),
    MONGO_DB_NAME: z.string().default('SmartHomeDB'),
    MONGO_DEVICES_COLLECTION: z.string().default('devices'),
    MONGO_TELEMETRY_COLLECTION: z.string().default('telemetry_logs'),
    TELEMETRY_BATCH_SIZE: z.coerce.number().positive().default(200),
    TELEMETRY_BATCH_FLUSH_MS: z.coerce.number().positive().default(1000),
    TELEMETRY_BUFFER_MAX: z.coerce.number().positive().default(5000),
    TELEMETRY_DEDUPE_TTL_SECONDS: z.coerce.number().positive().default(10),
    REDIS_DEDUPE_PREFIX: z.string().default('dedupe:'),

    // Worker behavior
    COMMAND_TIMEOUT_SECONDS: z.coerce.number().positive().default(15),
    COMMAND_RETRY_LIMIT: z.coerce.number().nonnegative().default(2),
    COMMAND_MAX_RETRY: z.coerce.number().nonnegative().default(5),
    COMMAND_PROCESSING_TTL_SECONDS: z.coerce.number().int().positive().default(120),
    COMMAND_IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
    HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().positive().default(30),
    HEALTHCHECK_INTERVAL_MS: z.coerce.number().positive().default(10000),
});

/**
 * Parse + Validate biến môi trường
 * 
 * Nếu schema sai, Zod sẽ ném error rõ ràng ngay khi import
 * Giúp ta không phải chạy đến đâu mới phát hiện config sai
 */
const parseResult = envSchema.safeParse(process.env);

if (!parseResult.success) {
    console.error('❌ Environment validation failed:');
    parseResult.error.errors.forEach(err => {
        console.error(`  ${err.path.join('.')}: ${err.message}`);
    });
    process.exit(1);
}

const config = parseResult.data;

/**
 * Export config object
 * 
 * Các service khác trong worker sẽ import đây để dùng config
 * Ví dụ: const { REDIS_URL } = require('./config/env');
 */
module.exports = config;
