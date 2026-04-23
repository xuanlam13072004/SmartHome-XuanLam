const Redis = require('ioredis');

/**
 * Tác dụng của file này:
 * - Tách toàn bộ logic kết nối Redis ra khỏi src/index.js
 * - Giúp index.js chỉ tập trung vào orchestration (khởi động / shutdown)
 * - Sau này nếu đổi Redis config hoặc thêm helper method sẽ sửa ở đây
 *
 * Ý tưởng thiết kế:
 * - Hàm createRedisClient nhận vào url và logger
 * - Tạo client Redis
 * - Gắn các event cơ bản để log lỗi / reconnect
 * - Trả về instance Redis để file khác dùng
 */
function createRedisClient({ redisUrl, logger }) {
    const redis = new Redis(redisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
    });

    redis.on('connect', () => {
        logger.info('Redis connecting');
    });

    redis.on('ready', () => {
        logger.info('Redis ready');
    });

    redis.on('error', (err) => {
        logger.error({ err }, 'Redis connection error');
    });

    redis.on('reconnecting', () => {
        logger.warn('Redis reconnecting');
    });

    redis.on('close', () => {
        logger.warn('Redis connection closed');
    });

    return redis;
}

module.exports = {
    createRedisClient,
};
