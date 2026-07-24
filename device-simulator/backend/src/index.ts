import fastify from 'fastify';
import { env } from './config/env';
import pino from 'pino';
import { initPostgres } from './infrastructure/postgres/client';
import { initMongo } from './infrastructure/mongodb/client';

const logger = pino({
    level: env.NODE_ENV === 'development' ? 'debug' : 'info',
    transport: env.NODE_ENV === 'development' ? {
        target: 'pino-pretty',
        options: { colorize: true }
    } : undefined
});

const app = fastify({ logger });

app.get('/api/health', async (request, reply) => {
    return { status: 'ok', service: 'device-simulator' };
});

app.get('/api/preflight', async (request, reply) => {
    return { 
        success: true, 
        enabled: env.SIMULATOR_ENABLED,
        environment: env.NODE_ENV
    };
});

import runsRoutes from './api/routes/runs';

const start = async () => {
    try {
        if (!env.SIMULATOR_ENABLED) {
            logger.warn('Simulator is disabled via SIMULATOR_ENABLED env variable. Exiting...');
            process.exit(0);
        }

        logger.info('Initializing databases...');
        await initPostgres(logger);
        await initMongo(logger);

        // Security Hook
        app.addHook('onRequest', async (request, reply) => {
            if (request.url.startsWith('/api/preflight') || request.url.startsWith('/api/health')) {
                return;
            }
            const token = request.headers.authorization?.replace('Bearer ', '');
            if (token !== env.ADMIN_TOKEN) {
                reply.status(401).send({ error: 'Unauthorized. Invalid admin token.' });
            }
        });

        app.register(runsRoutes);

        const port = env.PORT;
        const host = env.HOST;
        await app.listen({ port, host });
        logger.info(`✅ Simulator backend listening on http://${host}:${port}`);
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
};

start();
