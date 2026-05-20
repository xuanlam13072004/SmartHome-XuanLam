import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import Redis from 'ioredis';
import { env } from '../config/env';

/**
 * redisPlugin
 * - Kết nối Redis
 * - Ping để xác nhận kết nối
 * - Gắn client vào fastify instance
 */
const redisPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
    const redis = new Redis(env.REDIS_URL, {
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
    });

    redis.on('error', (err) => {
        app.log.error({ err }, 'Redis connection error');
    });

    await redis.ping();

    app.decorate('redis', redis);

    app.addHook('onClose', async () => {
        await redis.quit().catch(() => redis.disconnect());
    });
};

export default fp(redisPlugin, {
    name: 'redis-plugin',
});
