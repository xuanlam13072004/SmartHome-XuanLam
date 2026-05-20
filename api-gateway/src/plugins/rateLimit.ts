import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import rateLimit from '@fastify/rate-limit';

/**
 * rateLimitPlugin
 * - Bật rate limit cho các route cần bảo vệ (login)
 * - Mặc định global=false để áp dụng theo route
 */
const rateLimitPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
    app.register(rateLimit, {
        global: false,
        addHeaders: {
            'x-ratelimit-limit': true,
            'x-ratelimit-remaining': true,
            'x-ratelimit-reset': true,
        },
    });
};

export default fp(rateLimitPlugin, {
    name: 'rate-limit-plugin',
});
