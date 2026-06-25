/**
 * mqtt-worker-service/src/services/presenceManager.js
 * 
 * Lớp dịch vụ quản lý trạng thái Presence (trực tuyến/ngoại tuyến) của thiết bị.
 * Decoupled hoàn toàn khỏi Telemetry Processor.
 */

const { REDIS_CHANNELS, CACHE_PREFIXES } = require('../../../shared/constants');
const { recordPresenceTransition } = require('../monitoring/metrics');

/**
 * recordActivity: Ghi nhận hoạt động cuối cùng của thiết bị từ nhiều nguồn khác nhau.
 * Cập nhật lease thời gian trong Redis, trạng thái is_online và last_activity_source trong MongoDB.
 * 
 * @param {object} clients - { redis, mongoClient }
 * @param {string} deviceId - MAC address
 * @param {string} ownerId - owner UUID
 * @param {string} source - Nguồn phát sinh hoạt động ('telemetry', 'ack', 'heartbeat', 'stream')
 * @param {object} config - config variables
 * @param {object} logger - logger instance
 */
async function recordActivity(clients, deviceId, ownerId, source, config, logger) {
    const onlineKey = `${CACHE_PREFIXES.ONLINE_LEASE}${deviceId}`;
    try {
        const alreadyOnline = await clients.redis.exists(onlineKey);
        // Thiết lập/Gia hạn thời gian online trong 25 giây
        await clients.redis.set(onlineKey, '1', 'EX', 25);

        const db = clients.mongoClient.db(config.MONGO_DB_NAME);
        const collection = db.collection(config.MONGO_DEVICES_COLLECTION);
        const now = new Date();

        // 1. Cập nhật MongoDB shadow: is_online = true, last_activity_source, last_seen
        await collection.updateOne(
            { _id: deviceId },
            {
                $set: {
                    is_online: true,
                    last_seen: now,
                    last_updated: now,
                    last_activity_source: source
                }
            },
            { upsert: true }
        );

        // 2. Nếu chuyển đổi trạng thái từ OFFLINE -> ONLINE, publish sự kiện lên Redis Pub/Sub
        if (!alreadyOnline) {
            logger.info({ device_id: deviceId, owner_id: ownerId, source }, 'Presence: Device transitioned to ONLINE');
            try { recordPresenceTransition(true); } catch (mErr) {}
            const statusPayload = {
                owner_id: ownerId,
                mac: deviceId,
                payload: {
                    is_online: true,
                    last_seen: now.toISOString(),
                    last_activity_source: source
                },
                timestamp: now.toISOString()
            };
            await clients.redis.publish(REDIS_CHANNELS.DEVICE_STATUS, JSON.stringify(statusPayload));
        }
    } catch (err) {
        logger.error({ err, device_id: deviceId, source }, 'Presence: Failed to record device activity');
    }
}

/**
 * markDeviceOffline: Cập nhật trạng thái thiết bị ngoại tuyến trong MongoDB và phát sự kiện Pub/Sub.
 * 
 * @param {object} clients - { redis, mongoClient }
 * @param {string} mac - MAC address
 * @param {string} ownerId - owner UUID
 * @param {object} config - cấu hình
 * @param {object} logger - logger instance
 * @param {string} source - Lý do offline (ví dụ: 'Redis Expiry', 'Presence Sweep')
 */
async function markDeviceOffline(clients, mac, ownerId, config, logger, source) {
    const db = clients.mongoClient.db(config.MONGO_DB_NAME);
    const collection = db.collection(config.MONGO_DEVICES_COLLECTION);
    const now = new Date();

    // Cập nhật MongoDB shadow chỉ khi thiết bị thực sự đang online
    const result = await collection.updateOne(
        { _id: mac, is_online: true },
        {
            $set: {
                is_online: false,
                last_updated: now,
                last_activity_source: source
            }
        }
    );

    if (result.modifiedCount > 0) {
        logger.info({ mac, owner_id: ownerId, source }, 'Presence: Device updated to OFFLINE in MongoDB');
        try { recordPresenceTransition(false); } catch (mErr) {}
        
        // Publish offline event lên global status channel
        const statusPayload = {
            owner_id: ownerId,
            mac: mac,
            payload: {
                is_online: false,
                last_seen: now.toISOString(),
                last_activity_source: source
            },
            timestamp: now.toISOString()
        };

        await clients.redis.publish(REDIS_CHANNELS.DEVICE_STATUS, JSON.stringify(statusPayload));
        logger.debug({ mac, owner_id: ownerId, source }, 'Presence: Published offline status event');
    } else {
        logger.debug({ mac, source }, 'Presence: Device was already offline, skipping status publish');
    }
}

/**
 * performPresenceSweep: Quét MongoDB tìm các thiết bị quá hạn 25s chưa báo cáo hoạt động để cập nhật offline.
 * 
 * @param {object} clients - { redis, mongoClient }
 * @param {object} config - cấu hình
 * @param {object} logger - logger instance
 */
async function performPresenceSweep(clients, config, logger) {
    const db = clients.mongoClient.db(config.MONGO_DB_NAME);
    const collection = db.collection(config.MONGO_DEVICES_COLLECTION);
    const threshold = new Date(Date.now() - 25000); // Inactive 25 giây trước
    const now = new Date();

    // Tìm các thiết bị đang online nhưng last_seen cũ hơn threshold
    const expiredDevices = await collection.find({
        is_online: true,
        last_seen: { $lt: threshold }
    }).toArray();

    if (expiredDevices.length === 0) {
        return;
    }

    const macs = expiredDevices.map(d => d._id);
    logger.info({ count: expiredDevices.length, macs }, 'Presence Sweep: Found inactive devices, marking offline');

    // 1. Cập nhật is_online = false hàng loạt
    const sweepRes = await collection.updateMany(
        { _id: { $in: macs } },
        {
            $set: {
                is_online: false,
                last_updated: now,
                last_activity_source: 'Presence Sweep'
            }
        }
    );

    if (sweepRes.modifiedCount > 0) {
        for (let i = 0; i < sweepRes.modifiedCount; i++) {
            try { recordPresenceTransition(false); } catch (mErr) {}
        }
    }

    // 2. Publish offline event cho từng thiết bị
    for (const dev of expiredDevices) {
        const lastSeenStr = dev.last_seen ? dev.last_seen.toISOString() : threshold.toISOString();
        const statusPayload = {
            owner_id: dev.owner_id,
            mac: dev._id,
            payload: {
                is_online: false,
                last_seen: lastSeenStr,
                last_activity_source: 'Presence Sweep'
            },
            timestamp: now.toISOString()
        };

        try {
            await clients.redis.publish(REDIS_CHANNELS.DEVICE_STATUS, JSON.stringify(statusPayload));
            logger.debug({ mac: dev._id, owner_id: dev.owner_id }, 'Presence Sweep: Published offline status event');
        } catch (pubErr) {
            logger.error({ pubErr, mac: dev._id }, 'Presence Sweep: Failed to publish offline status event');
        }
    }
}

module.exports = {
    recordActivity,
    markDeviceOffline,
    performPresenceSweep
};
