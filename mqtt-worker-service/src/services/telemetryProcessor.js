/**
 * mqtt-worker-service/src/services/telemetryProcessor.js
 * 
 * Bộ điều phối Telemetry Pipeline (Telemetry Processor) tinh gọn,
 * đóng vai trò orchestrator điều phối tuần tự qua các service chuyên biệt:
 * 1. Validate (Zod)
 * 2. Dedupe (Redis NX)
 * 3. Sequence Gap Detection (Redis L2 check)
 * 4. Resolve Context (L1 LRU Cache & L2 Redis)
 * 5. Sanitize (TelemetrySanitizer)
 * 6. Write Telemetry & Shadow (TelemetryBatchWriter, ShadowBatchWriter)
 * 7. Publish Realtime (RealtimePublisher)
 * 8. Presence Record (PresenceManager)
 */

const crypto = require('crypto');
const { z } = require('zod');
const { CACHE_PREFIXES } = require('../../../shared/constants');
const { observeLatency } = require('../monitoring/metrics');
const { recordActivity } = require('./presenceManager');

// Lớp LRUMap nội bộ cho cache L1
class LRUMap {
    constructor(maxSize) {
        this.maxSize = maxSize;
        this.map = new Map();
    }
    get(key) {
        if (!this.map.has(key)) return undefined;
        const entry = this.map.get(key);
        this.map.delete(key);
        this.map.set(key, entry);
        return entry;
    }
    set(key, value) {
        if (this.map.has(key)) {
            this.map.delete(key);
        } else if (this.map.size >= this.maxSize) {
            const oldestKey = this.map.keys().next().value;
            if (oldestKey !== undefined) {
                this.map.delete(oldestKey);
            }
        }
        this.map.set(key, value);
    }
    delete(key) {
        return this.map.delete(key);
    }
    clear() {
        this.map.clear();
    }
}

// Khởi tạo L1 cache trong bộ nhớ
let l1ContextCache = new LRUMap(10000);
const L1_TTL_MS = 5 * 60 * 1000; // 5 phút
let redisSub = null;

/**
 * Đăng ký lắng nghe sự kiện cache invalidation qua Redis Pub/Sub
 */
function initTelemetryProcessor(clients, config, logger) {
    logger.info('TelemetryProcessor: Initializing L1 Context Cache and Invalidation Subscriber');
    l1ContextCache = new LRUMap(10000);

    if (clients.redis) {
        redisSub = clients.redis.duplicate({ lazyConnect: true });
        redisSub.connect().then(() => {
            redisSub.subscribe('device.context.invalidated', (mac) => {
                logger.info({ mac }, 'TelemetryProcessor: Evicted device context from L1 cache on invalidation event');
                l1ContextCache.delete(mac);
            }).catch(err => {
                logger.error({ err }, 'TelemetryProcessor: Invalidation subscribe failed');
            });
        }).catch(err => {
            logger.error({ err }, 'TelemetryProcessor: Invalidation Redis connection failed');
        });
    }

    return async () => {
        if (redisSub) {
            try {
                await redisSub.quit();
                logger.info('TelemetryProcessor: Closed cache invalidation subscriber');
            } catch (err) {
                logger.error({ err }, 'TelemetryProcessor: Error closing invalidation subscriber');
            }
        }
    };
}

// Zod Schema cho telemetry packet
const telemetrySchema = z.object({
    device_id: z.string(),
    timestamp: z.string().datetime().optional(),
    seq: z.coerce.number().int().nonnegative().optional(),
    metrics: z.record(z.any()),
    rssi: z.number().optional(),
    battery: z.number().optional(),
    trace_id: z.string().optional(),
});

function getTelemetryDedupeId(telemetry) {
    if (typeof telemetry.seq === 'number') {
        return `seq:${telemetry.seq}`;
    }
    if (telemetry.timestamp) {
        const ts = new Date(telemetry.timestamp).getTime();
        return `ts:${ts}`;
    }
    const payloadHash = crypto
        .createHash('sha1')
        .update(JSON.stringify(telemetry.metrics))
        .digest('hex');
    return `hash:${payloadHash}`;
}

async function shouldProcessTelemetry(redis, telemetry, config, logger) {
    const dedupeId = getTelemetryDedupeId(telemetry);
    const dedupeKey = `${config.REDIS_DEDUPE_PREFIX}${telemetry.device_id}:${dedupeId}`;

    try {
        const result = await redis.set(dedupeKey, '1', 'EX', config.TELEMETRY_DEDUPE_TTL_SECONDS, 'NX');
        if (result !== 'OK') {
            logger.debug({ device_id: telemetry.device_id, dedupe_id: dedupeId }, 'Duplicate telemetry dropped');
            return false;
        }
        return true;
    } catch (err) {
        logger.error({ err, device_id: telemetry.device_id }, 'Telemetry dedupe failed, allowing processing');
        return true;
    }
}

/**
 * Phân giải Context (Owner ID, Product ID, Firmware Version) kết hợp L1 Cache + L2 Redis
 */
async function resolveDeviceContext(clients, deviceId, config, logger) {
    const cached = l1ContextCache.get(deviceId);
    if (cached && Date.now() < cached.expiresAt) {
        return cached.context;
    }

    const ownerCacheKey = `${CACHE_PREFIXES.OWNER_OF}${deviceId}`;
    const productCacheKey = `${CACHE_PREFIXES.PRODUCT_OF}${deviceId}`;

    try {
        const [ownerId, productId] = await Promise.all([
            clients.redis.get(ownerCacheKey),
            clients.redis.get(productCacheKey)
        ]);

        if (ownerId && productId) {
            const context = { ownerId, productId, firmwareVersion: null };
            l1ContextCache.set(deviceId, { context, expiresAt: Date.now() + L1_TTL_MS });
            return context;
        }

        logger.warn({ device_id: deviceId }, 'Device context cache miss in Redis, falling back to MongoDB shadow');
        const db = clients.mongoClient.db(config.MONGO_DB_NAME);
        const collection = db.collection(config.MONGO_DEVICES_COLLECTION);
        const doc = await collection.findOne({ _id: deviceId }, { projection: { owner_id: 1, product_id: 1, firmware_version: 1 } });

        if (doc) {
            const context = {
                ownerId: doc.owner_id || null,
                productId: doc.product_id || null,
                firmwareVersion: doc.firmware_version || null
            };

            if (context.ownerId) await clients.redis.set(ownerCacheKey, context.ownerId);
            if (context.productId) await clients.redis.set(productCacheKey, context.productId);

            l1ContextCache.set(deviceId, { context, expiresAt: Date.now() + L1_TTL_MS });
            return context;
        }

        logger.error({ device_id: deviceId }, 'Device context not found in MongoDB Devices collection');
        return { ownerId: null, productId: null, firmwareVersion: null };
    } catch (err) {
        logger.error({ err, device_id: deviceId }, 'Failed to resolve device context');
        return { ownerId: null, productId: null, firmwareVersion: null };
    }
}

/**
 * Hàm điều phối luồng Telemetry Pipeline
 */
async function processTelemetry(rawMessage, clients, config, logger) {
    const startTime = process.hrtime.bigint();
    let telemetry;

    // 1. Validate Zod Schema
    try {
        telemetry = telemetrySchema.parse(rawMessage);
    } catch (err) {
        logger.error({ err, message: rawMessage }, 'TelemetryProcessor: Invalid telemetry schema');
        throw new Error(`Schema validation failed: ${err.message}`);
    }

    const deviceId = telemetry.device_id;

    // 2. Deduplicate
    const allowProcess = await shouldProcessTelemetry(clients.redis, telemetry, config, logger);
    if (!allowProcess) return null;

    // 3. Sequence Gap Detection (survives restart using Redis key last_seq:{device})
    if (telemetry.seq !== undefined) {
        const seqKey = `last_seq:${deviceId}`;
        try {
            const lastSeqStr = await clients.redis.get(seqKey);
            if (lastSeqStr !== null) {
                const lastSeq = parseInt(lastSeqStr, 10);
                if (telemetry.seq > lastSeq + 1) {
                    const missing = [];
                    for (let s = lastSeq + 1; s < telemetry.seq; s++) {
                        missing.push(s);
                    }
                    logger.warn(
                        { device_id: deviceId, last_seq: lastSeq, current_seq: telemetry.seq, missing_packets: missing },
                        `Sequence Gap Detected: Missing packets [${missing.join(', ')}]`
                    );
                }
            }
            await clients.redis.set(seqKey, telemetry.seq.toString());
        } catch (redisErr) {
            logger.error({ err: redisErr, device_id: deviceId }, 'Failed to check/update sequence in Redis');
        }
    }

    // 4. Resolve Context
    const context = await resolveDeviceContext(clients, deviceId, config, logger);
    if (!context.ownerId || !context.productId) {
        logger.warn({ device_id: deviceId }, 'TelemetryProcessor: Owner or Product not resolved, skipping telemetry');
        return null;
    }

    // Lấy product spec từ Catalog Cache
    const product = clients.catalogCache.getProduct(context.productId);
    if (!product) {
        logger.warn({ device_id: deviceId, product_id: context.productId }, 'TelemetryProcessor: Product metadata missing, skipping');
        return null;
    }

    const reportedFirmware = telemetry.metrics?.firmware_version || context.firmwareVersion;

    // 5. Lọc & Validate bằng TelemetrySanitizer (Single Responsibility)
    const { sanitizedState, sanitizedDiagnostics, warnings } = clients.telemetrySanitizer.sanitize(
        telemetry,
        product,
        reportedFirmware
    );

    if (warnings.length > 0) {
        logger.warn({ device_id: deviceId, count: warnings.length, warnings }, 'TelemetryProcessor: Sanitizer warnings reported');
    }

    try {
        // 6. Ghi lô (Batch Writers)
        const telemetryDoc = {
            metadata: { device_id: deviceId, owner_id: context.ownerId },
            timestamp: telemetry.timestamp ? new Date(telemetry.timestamp) : new Date(),
            trace_id: telemetry.trace_id || null,
            ...sanitizedState,
            ...sanitizedDiagnostics
        };

        if (clients.telemetryWriter) {
            clients.telemetryWriter.add(telemetryDoc);
        }

        if (clients.shadowWriter) {
            clients.shadowWriter.add(deviceId, context.ownerId, {
                stateUpdates: sanitizedState,
                diagnosticUpdates: {
                    ...sanitizedDiagnostics,
                    ...(reportedFirmware ? { firmware_version: reportedFirmware } : {})
                }
            });
        }

        // 7. Publish Realtime (RealtimePublisher)
        if (clients.realtimePublisher) {
            await clients.realtimePublisher.publishTelemetry(
                context.ownerId,
                deviceId,
                sanitizedState,
                sanitizedDiagnostics,
                telemetry.timestamp,
                telemetry.trace_id || null
            );
        }

        // 8. Presence Record activity
        await recordActivity(clients, deviceId, context.ownerId, 'telemetry', config, logger);

        // Đo latency xử lý
        const durationSec = Number(process.hrtime.bigint() - startTime) / 1e9;
        observeLatency(durationSec);

        logger.info(
            { device_id: deviceId, owner_id: context.ownerId, duration_ms: (durationSec * 1000).toFixed(2) },
            'Telemetry processed successfully'
        );

        return deviceId;
    } catch (err) {
        logger.error({ err, device_id: deviceId }, 'Failed to process telemetry message');
        throw err;
    }
}

module.exports = {
    initTelemetryProcessor,
    resolveDeviceContext,
    processTelemetry,
    getTelemetryDedupeId,
    shouldProcessTelemetry
};
