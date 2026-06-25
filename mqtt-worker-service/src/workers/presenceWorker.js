/**
 * presenceWorker.js
 * 
 * - Lắng nghe sự kiện hết hạn khóa Redis (device:online:${mac}) qua Keyspace Expired Event để chuyển offline tức thời.
 * - Chạy định kỳ một sweep scanner (15s) trên MongoDB làm lớp bảo vệ (self-healing fallback).
 */

const { resolveDeviceContext } = require('../services/telemetryProcessor');
const { markDeviceOffline, performPresenceSweep } = require('../services/presenceManager');
const { CACHE_PREFIXES } = require('../../../shared/constants');

/**
 * startPresenceWorker
 * 
 * @param {object} clients - { redis, mongoClient }
 * @param {object} config - config variables
 * @param {object} logger - logger instance
 * @returns {Promise<Function>} hàm cleanup giải phóng tài nguyên
 */
async function startPresenceWorker(clients, config, logger) {
    logger.info('Starting Presence Worker...');

    // 1. Cấu hình Redis bật Keyspace Notifications cho sự kiện Expire
    try {
        await clients.redis.config('SET', 'notify-keyspace-events', 'Ex');
        logger.info('Redis keyspace notifications configured (Ex)');
    } catch (err) {
        logger.warn({ err }, 'Failed to configure Redis keyspace notifications, they might be already enabled or CONFIG command is disabled.');
    }

    // 2. Tạo kết nối Redis Subscriber riêng biệt cho presence events
    const redisSub = clients.redis.duplicate();
    await redisSub.connect().catch((err) => {
        logger.debug({ err }, 'Redis duplicate subscriber connect details');
    });

    const EXPIRED_PATTERN = '__keyevent@*__:expired';
    try {
        await redisSub.psubscribe(EXPIRED_PATTERN);
        logger.info(`Presence: Subscribed to Redis Expired events with pattern: ${EXPIRED_PATTERN}`);
    } catch (err) {
        logger.error({ err }, 'Presence: Failed to subscribe to Redis expired events pattern');
        throw err;
    }

    // Xử lý sự kiện khi khóa hết hạn trong Redis
    redisSub.on('pmessage', async (pattern, channel, message) => {
        const PREFIX = CACHE_PREFIXES.ONLINE_LEASE;
        if (message.startsWith(PREFIX)) {
            const mac = message.substring(PREFIX.length);
            logger.info({ mac, channel }, 'Presence: Key expired event captured, transitioning device to OFFLINE');

            try {
                // Phân giải owner_id và product_id thông qua Device Context Resolver
                const { ownerId } = await resolveDeviceContext(clients, mac, config, logger);
                if (!ownerId) {
                    logger.warn({ mac }, 'Presence: Cannot resolve owner for device to mark offline');
                    return;
                }

                await markDeviceOffline(clients, mac, ownerId, config, logger, `Redis Expiry (${channel})`);
            } catch (err) {
                logger.error({ err, mac }, 'Presence: Failed to mark device offline on expiry event');
            }
        }
    });

    // 3. Ticker chạy quét định kỳ (15s) trên MongoDB làm lớp bảo vệ
    const sweepIntervalMs = 15000;
    const sweepTimer = setInterval(async () => {
        try {
            await performPresenceSweep(clients, config, logger);
        } catch (err) {
            logger.error({ err }, 'Presence Sweep: Error occurred during periodic sweep');
        }
    }, sweepIntervalMs);

    // Trả về hàm dọn dẹp khi tắt service
    return () => {
        clearInterval(sweepTimer);
        redisSub.quit().catch(() => {});
        logger.info('Presence Worker stopped.');
    };
}

module.exports = {
    startPresenceWorker,
};
