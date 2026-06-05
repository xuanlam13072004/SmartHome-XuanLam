/**
 * Tác dụng của file này:
 * - Xử lý telemetry (dữ liệu cảm biến) từ ESP32
 * - Nhận từ MQTT broker -> validate -> resolve owner -> ghi Mongo -> phát realtime
 *
 * Luồng xử lý:
 * ESP32 -> MQTT (topic: smarthome/{owner_id}/{device_id}/telemetry)
 *   -> Worker subscribe & parse
 *   -> validate schema
 *   -> resolve owner_id (Redis cache hit 90%)
 *   -> insert telemetry_logs (MongoDB time-series)
 *   -> update devices shadow (MongoDB)
 *   -> publish device.updates (Redis Pub/Sub -> Realtime Service)
 */

const crypto = require('crypto');
const { z } = require('zod');

// In-memory batch buffers for telemetry logs & shadows
const telemetryBatch = [];
const shadowBatchMap = new Map();
let flushTimer = null;
let flushInProgress = false;

/**
 * Schema validate cho telemetry message từ MQTT
 * 
 * Mục đích:
 * - Đảm bảo sensor data từ ESP32 có định dạng chuẩn
 * - Fail fast nếu thiếu timestamp hoặc metrics
 * - Dễ debug lỗi format từ device
 */
const telemetrySchema = z.object({
    device_id: z.string(), // MAC address
    timestamp: z.string().datetime().optional(),
    seq: z.coerce.number().int().nonnegative().optional(),
    metrics: z.record(z.any()), // { temp: 28.5, humidity: 65, relay: "ON" }
    rssi: z.number().optional(), // signal strength
    battery: z.number().optional(), // battery level
});

/**
 * getTelemetryDedupeId: tạo id để chống duplicate telemetry
 * 
 * Ưu tiên:
 * 1) seq từ device
 * 2) timestamp
 * 3) hash payload (fallback)
 * 
 * @param {object} telemetry - validated telemetry data
 * @returns {string} dedupe id
 */
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

/**
 * shouldProcessTelemetry: kiểm tra telemetry có bị duplicate không
 * 
 * Dùng Redis SET NX + TTL để đảm bảo 1 telemetry chỉ xử lý 1 lần
 * 
 * @param {object} redis - Redis client
 * @param {object} telemetry - validated telemetry data
 * @param {object} config - biến config
 * @param {object} logger - logger instance
 * @returns {Promise<boolean>} true nếu nên xử lý
 */
async function shouldProcessTelemetry(redis, telemetry, config, logger) {
    const dedupeId = getTelemetryDedupeId(telemetry);
    const dedupeKey = `${config.REDIS_DEDUPE_PREFIX}${telemetry.device_id}:${dedupeId}`;

    try {
        const result = await redis.set(
            dedupeKey,
            '1',
            'EX',
            config.TELEMETRY_DEDUPE_TTL_SECONDS,
            'NX'
        );

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
 * validateTelemetry: kiểm tra message có đúng schema không
 * 
 * @param {object} message - raw message từ MQTT
 * @returns {object} parsed message hoặc throw error
 */
function validateTelemetry(message) {
    return telemetrySchema.parse(message);
}

/**
 * resolveOwnerId: tìm owner_id từ device_id
 * 
 * Luồng:
 * 1. Thử đọc từ Redis cache (key: owner_of:{device_id})
 * 2. Nếu cache miss, query PostgreSQL device_metadata
 * 3. Nạp lại cache + TTL 1 giờ
 * 4. Nếu device không tồn tại -> log error + skip
 * 
 * @param {object} clients - { redis, pgPool }
 * @param {string} deviceId - MAC address
 * @param {object} config - biến config (cache TTL)
 * @param {object} logger - logger instance
 * @returns {Promise<string|null>} owner_id hoặc null nếu device không tồn tại
 */
async function resolveOwnerId(clients, deviceId, config, logger) {
    const cacheKey = `${config.REDIS_CACHE_OWNER_PREFIX}${deviceId}`;

    try {
        // Bước 1: Thử Redis cache
        let ownerId = await clients.redis.get(cacheKey);

        if (ownerId) {
            logger.debug({ device_id: deviceId }, 'Owner resolved from cache');
            return ownerId;
        }

        // Bước 2: Cache miss, query PostgreSQL
        logger.debug({ device_id: deviceId }, 'Owner cache miss, querying PostgreSQL');

        const result = await clients.pgPool.query(
            'SELECT owner_id FROM device_metadata WHERE mac = $1',
            [deviceId]
        );

        if (result.rows.length === 0) {
            logger.warn({ device_id: deviceId }, 'Device not found in PostgreSQL');
            return null;
        }

        ownerId = result.rows[0].owner_id;

        // Bước 3: Nạp cache
        await clients.redis.setex(
            cacheKey,
            config.REDIS_CACHE_TTL_SECONDS,
            ownerId
        );

        logger.debug({ device_id: deviceId }, 'Owner cached');
        return ownerId;
    } catch (err) {
        logger.error({ err, device_id: deviceId }, 'Failed to resolve owner');
        return null;
    }
}

/**
 * insertTelemetryLog: gom dữ liệu vào telemetryBatch (lịch sử cảm biến)
 * 
 * @param {object} mongoClient - MongoDB client
 * @param {object} telemetry - validated telemetry data
 * @param {string} ownerId - owner UUID
 * @param {object} config - biến config (collection names)
 * @param {object} logger - logger instance
 * @returns {Promise<null>}
 */
async function insertTelemetryLog(mongoClient, telemetry, ownerId, config, logger) {
    const doc = {
        metadata: {
            device_id: telemetry.device_id,
            owner_id: ownerId,
        },
        timestamp: telemetry.timestamp ? new Date(telemetry.timestamp) : new Date(),
        ...telemetry.metrics,
        ...(telemetry.rssi && { rssi: telemetry.rssi }),
        ...(telemetry.battery && { battery: telemetry.battery }),
    };

    if (telemetryBatch.length >= config.TELEMETRY_BUFFER_MAX) {
        logger.warn(
            { buffer_size: telemetryBatch.length, device_id: telemetry.device_id },
            'Telemetry buffer full, dropping message'
        );
        return null;
    }

    telemetryBatch.push(doc);
    return null;
}

/**
 * scheduleAllBatchesFlush: set timeout để flush các batch nếu chưa đủ size
 */
function scheduleAllBatchesFlush(mongoClient, config, logger) {
    if (flushTimer) return;

    flushTimer = setTimeout(() => {
        flushAllBatches(mongoClient, config, logger).catch((err) => {
            logger.error({ err }, 'Batches flush failed');
        });
    }, config.TELEMETRY_BATCH_FLUSH_MS);
}

/**
 * flushAllBatches: ghi batch telemetry & shadow bằng insertMany + bulkWrite song song
 */
async function flushAllBatches(mongoClient, config, logger) {
    if (flushInProgress) return;
    if (telemetryBatch.length === 0 && shadowBatchMap.size === 0) return;

    flushInProgress = true;

    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }

    const db = mongoClient.db(config.MONGO_DB_NAME);
    const telemetryCollection = db.collection(config.MONGO_TELEMETRY_COLLECTION);
    const devicesCollection = db.collection(config.MONGO_DEVICES_COLLECTION);

    // Lấy tối đa TELEMETRY_BATCH_SIZE log để insert
    const logsBatch = telemetryBatch.splice(0, config.TELEMETRY_BATCH_SIZE);

    // Chuẩn bị bulkWrite cho shadow updates của các thiết bị tích lũy trong shadowBatchMap
    const shadowOps = [];
    for (const [mac, updateDoc] of shadowBatchMap.entries()) {
        shadowOps.push({
            updateOne: {
                filter: { _id: mac },
                update: { $set: updateDoc },
                upsert: true
            }
        });
    }
    shadowBatchMap.clear();

    const writePromises = [];

    if (logsBatch.length > 0) {
        writePromises.push(
            telemetryCollection.insertMany(logsBatch, { ordered: false })
                .then((result) => {
                    logger.debug(
                        { inserted: result.insertedCount, batch_size: logsBatch.length },
                        'Telemetry batch inserted'
                    );
                })
                .catch((err) => {
                    logger.error({ err, batch_size: logsBatch.length }, 'Failed to insert telemetry batch');
                })
        );
    }

    if (shadowOps.length > 0) {
        writePromises.push(
            devicesCollection.bulkWrite(shadowOps, { ordered: false })
                .then((result) => {
                    logger.debug(
                        { matched: result.matchedCount, upserted: result.upsertedCount, ops_size: shadowOps.length },
                        'Shadow bulk updates completed'
                    );
                })
                .catch((err) => {
                    logger.error({ err, ops_size: shadowOps.length }, 'Failed to bulk write shadow updates');
                })
        );
    }

    try {
        await Promise.all(writePromises);
    } catch (err) {
        // Lỗi chi tiết đã được xử lý/log trong từng promise
    } finally {
        flushInProgress = false;

        // Nếu vẫn còn dữ liệu chưa flush hết (trong trường hợp dồn dập vượt quá BATCH_SIZE), lên lịch flush tiếp
        if (telemetryBatch.length > 0 || shadowBatchMap.size > 0) {
            scheduleAllBatchesFlush(mongoClient, config, logger);
        }
    }
}

/**
 * updateDeviceShadow: gom dữ liệu vào shadowBatchMap (trạng thái thiết bị shadow)
 * 
 * @param {object} mongoClient - MongoDB client
 * @param {object} telemetry - validated telemetry data
 * @param {string} ownerId - owner UUID
 * @param {object} config - biến config (collection names)
 * @param {object} logger - logger instance
 * @returns {Promise<null>}
 */
async function updateDeviceShadow(mongoClient, telemetry, ownerId, config, logger) {
    const updateDoc = {
        owner_id: ownerId,
        state: telemetry.metrics,
        last_updated: new Date(),
        last_seen: new Date(),
        is_online: true,
        ...(telemetry.rssi && { rssi: telemetry.rssi }),
        ...(telemetry.battery && { battery: telemetry.battery }),
    };

    shadowBatchMap.set(telemetry.device_id, updateDoc);
    return null;
}

/**
 * publishTelemetryUpdate: phát event telemetry update lên Redis cho Realtime Service
 * 
 * Mục đích:
 * - Realtime Service subscribe Redis channel này
 * - Lấy event, lọc theo owner_id, push WebSocket về app
 * - App re-render UI với dữ liệu mới ngay
 * 
 * @param {object} redis - Redis client
 * @param {string} ownerId - owner UUID
 * @param {object} telemetry - validated telemetry data
 * @param {object} config - biến config (channel name)
 * @param {object} logger - logger instance
 * @returns {Promise}
 */
async function publishTelemetryUpdate(redis, ownerId, telemetry, config, logger) {
    const payload = {
        type: 'device_update',
        owner_id: ownerId,
        device_id: telemetry.device_id,
        state: telemetry.metrics,
        timestamp: telemetry.timestamp || new Date().toISOString(),
    };

    try {
        await redis.publish(
            config.REDIS_UPDATE_CHANNEL,
            JSON.stringify(payload)
        );
        logger.debug({ device_id: telemetry.device_id }, 'Telemetry update published');
    } catch (err) {
        logger.error({ err, device_id: telemetry.device_id }, 'Failed to publish telemetry update');
        // Không throw - realtime không critical như storage
    }
}

/**
 * processTelemetry: luồng xử lý chính cho 1 bản telemetry
 * 
 * Bước:
 * 1. Validate schema
 * 2. Dedupe bằng Redis SET NX
 * 3. Resolve owner_id (cache / DB fallback)
 * 4. Gom telemetry log vào telemetryBatch
 * 5. Gom shadow update vào shadowBatchMap
 * 6. Kích hoạt ghi theo lô hoặc lên lịch flush định kỳ
 * 7. Publish realtime event (Redis)
 * 
 * @param {object} rawMessage - message từ MQTT
 * @param {object} clients - { redis, pgPool, mongoClient }
 * @param {object} config - biến môi trường
 * @param {object} logger - logger instance
 * @returns {Promise<string>} device_id đã xử lý
 */
async function processTelemetry(rawMessage, clients, config, logger) {
    let telemetry;

    // Bước 1: Validate schema
    try {
        telemetry = validateTelemetry(rawMessage);
    } catch (err) {
        logger.error({ err, message: rawMessage }, 'Invalid telemetry schema');
        throw new Error(`Schema validation failed: ${err.message}`);
    }

    // Bước 2: Dedupe telemetry
    const allowProcess = await shouldProcessTelemetry(clients.redis, telemetry, config, logger);

    if (!allowProcess) {
        return null;
    }

    // Bước 3: Resolve owner_id
    const ownerId = await resolveOwnerId(clients, telemetry.device_id, config, logger);

    if (!ownerId) {
        logger.warn({ device_id: telemetry.device_id }, 'Device owner not found, skipping telemetry');
        return null;
    }

    try {
        // Bước 4: Gom telemetry_logs
        await insertTelemetryLog(clients.mongoClient, telemetry, ownerId, config, logger);

        // Bước 5: Gom device shadow
        await updateDeviceShadow(clients.mongoClient, telemetry, ownerId, config, logger);

        // Kích hoạt ghi theo lô nếu vượt quá kích thước quy định
        if (telemetryBatch.length >= config.TELEMETRY_BATCH_SIZE || shadowBatchMap.size >= config.TELEMETRY_BATCH_SIZE) {
            await flushAllBatches(clients.mongoClient, config, logger);
        } else {
            scheduleAllBatchesFlush(clients.mongoClient, config, logger);
        }

        // Bước 6: Publish realtime event
        await publishTelemetryUpdate(clients.redis, ownerId, telemetry, config, logger);

        logger.info(
            { device_id: telemetry.device_id, owner_id: ownerId },
            'Telemetry processed successfully'
        );

        return telemetry.device_id;
    } catch (err) {
        logger.error(
            { err, device_id: telemetry.device_id, owner_id: ownerId },
            'Failed to process telemetry'
        );
        throw err;
    }
}

module.exports = {
    validateTelemetry,
    getTelemetryDedupeId,
    shouldProcessTelemetry,
    resolveOwnerId,
    insertTelemetryLog,
    updateDeviceShadow,
    publishTelemetryUpdate,
    processTelemetry,
};
