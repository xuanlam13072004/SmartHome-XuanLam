import crypto from 'node:crypto';
import cors from '@fastify/cors';
import fastify, {
    type FastifyBaseLogger,
    type FastifyInstance,
} from 'fastify';
import { env } from './config/env';
import {
    closePostgres,
    getPgPool,
    initPostgres,
} from './infrastructure/postgres/client';
import {
    closeMongo,
    initMongo,
    pingMongo,
} from './infrastructure/mongodb/client';
import { probeMqtt } from './infrastructure/mqtt/client';
import { apiGateway } from './infrastructure/api-gateway/client';
import { loadCatalog, getCachedCatalog } from './catalog/loader';
import { createRunsRoutes } from './api/routes/runs';
import { createUsersRoutes } from './api/routes/users';
import devicesRoutes from './api/routes/devices';
import eventsRoutes from './api/routes/events';
import streamRoutes from './api/routes/stream';
import catalogRoutes from './api/routes/catalog';
import { CleanupCronjob } from './cleanup/cronjob';
import { RecoveryService } from './recovery/service';
import { getRuntimeManager } from './runtime/manager';
import { getRunMetricsService } from './metrics/service';
import { getTelemetryScheduler } from './runtime/telemetry-scheduler';
import { retryStartupDependency } from './startup/retry';

interface PreflightCheck {
    status: 'ok' | 'error';
    latency_ms: number;
    message?: string;
}

const safeTokenEquals = (received: string | undefined, expected: string): boolean => {
    if (!received) return false;
    const receivedBuffer = Buffer.from(received);
    const expectedBuffer = Buffer.from(expected);
    return receivedBuffer.length === expectedBuffer.length
        && crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
};

const runCheck = async (operation: () => Promise<unknown>): Promise<PreflightCheck> => {
    const startedAt = performance.now();
    try {
        await operation();
        return {
            status: 'ok',
            latency_ms: Math.round(performance.now() - startedAt),
        };
    } catch (error) {
        return {
            status: 'error',
            latency_ms: Math.round(performance.now() - startedAt),
            message: error instanceof Error ? error.message : String(error),
        };
    }
};

const startDependency = <T>(
    name: string,
    operation: () => Promise<T>,
    logger: FastifyBaseLogger,
): Promise<T> => retryStartupDependency(name, operation, {
    attempts: env.STARTUP_RETRY_ATTEMPTS,
    delayMs: env.STARTUP_RETRY_DELAY_MS,
    onRetry: ({ attempt, attempts, delayMs, error }) => {
        logger.warn(
            {
                err: error,
                dependency: name,
                attempt,
                attempts,
                retry_in_ms: delayMs,
            },
            'Simulator dependency is unavailable; retrying startup',
        );
    },
});

export const buildApp = async (): Promise<{
    app: FastifyInstance;
    cleanupJob: CleanupCronjob;
}> => {
    if (!env.SIMULATOR_ENABLED) {
        throw new Error('Device Simulator is disabled. Set SIMULATOR_ENABLED=true to start it.');
    }

    const app = fastify({
        logger: {
            level: env.NODE_ENV === 'development' ? 'debug' : 'info',
            redact: {
                paths: [
                    'req.headers.authorization',
                    'authorization',
                    '*.password',
                    '*.secret',
                    '*.secret_key',
                    '*.credential',
                    '*.access_token',
                    '*.refresh_token',
                ],
                censor: '[REDACTED]',
            },
            transport: env.NODE_ENV === 'development'
                ? { target: 'pino-pretty', options: { colorize: true } }
                : undefined,
        },
    });

    const allowedOrigins = new Set(
        env.ADMIN_CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
    );
    await app.register(cors, {
        origin: (origin, callback) => {
            if (!origin || allowedOrigins.has(origin)) callback(null, true);
            else callback(new Error('Origin is not allowed by simulator CORS policy'), false);
        },
        methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
    });

    app.addHook('onRequest', async (request, reply) => {
        if (request.method === 'OPTIONS' || request.url.startsWith('/api/health')) return;
        const header = request.headers.authorization;
        const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
        if (!safeTokenEquals(token, env.ADMIN_TOKEN)) {
            return reply.status(401).send({
                success: false,
                error: { code: 'UNAUTHORIZED', message: 'Invalid simulator admin token' },
            });
        }
    });

    app.setErrorHandler((error, _request, reply) => {
        const typedError = error as Error & { statusCode?: number };
        const statusCode = Number(typedError.statusCode) || 500;
        if (statusCode >= 500) app.log.error({ err: error }, 'Unhandled simulator request error');
        else app.log.warn({ err: error }, 'Simulator request rejected');
        return reply.status(statusCode).send({
            success: false,
            error: {
                code: statusCode >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR',
                message: statusCode >= 500 ? 'Internal simulator error' : typedError.message,
            },
        });
    });

    app.get('/api/health', async () => ({
        status: 'ok',
        service: 'device-simulator',
        enabled: env.SIMULATOR_ENABLED,
        timestamp: new Date().toISOString(),
    }));

    app.get('/api/preflight', async (_request, reply) => {
        const checks = {
            api_gateway: await runCheck(() => apiGateway.health()),
            postgres: await runCheck(() => getPgPool().query('SELECT 1')),
            mongodb: await runCheck(() => pingMongo()),
            mqtt: await runCheck(() => probeMqtt()),
            catalog: await runCheck(async () => {
                if (getCachedCatalog().length === 0) throw new Error('Product catalog is empty');
            }),
        };
        const ready = Object.values(checks).every((check) => check.status === 'ok');
        return reply.status(ready ? 200 : 503).send({
            success: ready,
            enabled: env.SIMULATOR_ENABLED,
            environment: env.NODE_ENV,
            checks,
        });
    });

    await startDependency('PostgreSQL', () => initPostgres(app.log), app.log);
    await startDependency('MongoDB', () => initMongo(app.log), app.log);
    await startDependency('API Gateway Product Catalog', loadCatalog, app.log);
    app.log.info({ productCount: getCachedCatalog().length }, 'Product catalog loaded');
    const runtimeManager = getRuntimeManager(app.log);
    await startDependency('MQTT broker', () => runtimeManager.start(), app.log);
    const metricsService = getRunMetricsService(app.log);
    metricsService.start();

    const cleanupJob = new CleanupCronjob(app.log);
    await app.register(createRunsRoutes(cleanupJob));
    await app.register(createUsersRoutes(cleanupJob));
    await app.register(devicesRoutes);
    await app.register(eventsRoutes);
    await app.register(streamRoutes);
    await app.register(catalogRoutes);

    app.addHook('onClose', async () => {
        cleanupJob.stop();
        await runtimeManager.disconnectAll();
        getTelemetryScheduler().stop();
        await metricsService.stop();
        await Promise.all([closeMongo(), closePostgres()]);
    });

    return { app, cleanupJob };
};

export const start = async (): Promise<void> => {
    const { app, cleanupJob } = await buildApp();
    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info({ host: env.HOST, port: env.PORT }, 'Device Simulator backend listening');
    cleanupJob.start();
    await new RecoveryService(app.log).recover();
};

if (require.main === module) {
    start().catch(async (error) => {
        console.error('Device Simulator failed to start:', error);
        await Promise.allSettled([closeMongo(), closePostgres()]);
        process.exit(1);
    });
}
