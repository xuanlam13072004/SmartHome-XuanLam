import fastify, { FastifyInstance } from 'fastify';
import postgresPlugin from './plugins/postgres';
import redisPlugin from './plugins/redis';
import mongoPlugin from './plugins/mongo';
import authRoutes from './modules/auth/routes';
import deviceRoutes from './modules/device/routes';
import jwtPlugin from './plugins/jwt';
import errorHandlerPlugin from './plugins/errorHandler';
import validationPlugin from './plugins/validation';
import rateLimitPlugin from './plugins/rateLimit';

/**
 * buildApp
 * - Tạo Fastify instance
 * - Đăng ký các route cơ bản
 * - Trả về app để index.ts chạy listen
 */
export function buildApp(): FastifyInstance {
    const app = fastify({
        logger: true,
    });

    // Register global error handler
    app.register(errorHandlerPlugin);

    // Register validation plugin (Zod)
    app.register(validationPlugin);

    // Register PostgreSQL plugin (fail fast nếu DB lỗi)
    app.register(postgresPlugin);

    // Register Redis plugin (cache + pub/sub)
    app.register(redisPlugin);

    // Register Mongo plugin (telemetry + device shadow)
    app.register(mongoPlugin);

    // Register JWT plugin (auth + protected routes)
    app.register(jwtPlugin);

    // Register rate limit plugin
    app.register(rateLimitPlugin);

    // Register Auth module routes
    app.register(authRoutes);

    // Register Device module routes
    app.register(deviceRoutes);

    // Health check cho load balancer / k8s
    app.get('/health', async () => {
        return {
            status: 'ok',
            service: 'api-gateway',
        };
    });

    return app;
}
