import fastify, { FastifyInstance } from 'fastify';
import postgresPlugin from './plugins/postgres';
import redisPlugin from './plugins/redis';
import mongoPlugin from './plugins/mongo';
import authRoutes from './modules/auth/routes';
import deviceRoutes from './modules/device/routes';
import accountRoutes from './modules/account/routes';
import sharingRoutes from './modules/sharing/routes';
import notificationRoutes from './modules/notifications/routes';
import roomRoutes from './modules/rooms/routes';
import sceneRoutes from './modules/scenes/routes';
import automationRoutes from './modules/automations/routes';
import voiceRoutes from './modules/voice/routes';
import assistantRoutes from './modules/assistant/routes';
import paymentRoutes from './modules/payments/routes';
import pushRoutes from './modules/push/routes';
import jwtPlugin from './plugins/jwt';
import errorHandlerPlugin from './plugins/errorHandler';
import validationPlugin from './plugins/validation';
import rateLimitPlugin from './plugins/rateLimit';
import metricsPlugin from './plugins/metrics';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { corsOptions } from './config/cors';
import { env } from './config/env';
import { trustProxyOption } from './config/trustProxy';

/**
 * buildApp
 * - Tạo Fastify instance
 * - Đăng ký các route cơ bản
 * - Trả về app để index.ts chạy listen
 */
export function buildApp(): FastifyInstance {
    const app = fastify({
        logger: true,
        // Real client address behind Cloudflare Tunnel (config/trustProxy.ts).
        trustProxy: trustProxyOption(env.TRUST_PROXY),
    });

    // Security plugins
    app.register(metricsPlugin);
    app.register(helmet);
    app.register(cors, corsOptions);

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

    // Account center ("Cá nhân") and device sharing
    app.register(accountRoutes);
    app.register(sharingRoutes);
    app.register(notificationRoutes);
    app.register(roomRoutes);
    app.register(sceneRoutes);
    app.register(automationRoutes);
    app.register(voiceRoutes);
    app.register(assistantRoutes);
    app.register(paymentRoutes);
    app.register(pushRoutes);

    // Health check cho load balancer / k8s
    app.get('/health', async () => {
        return {
            status: 'ok',
            service: 'api-gateway',
        };
    });

    return app;
}
