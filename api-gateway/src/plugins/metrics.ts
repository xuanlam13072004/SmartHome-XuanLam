import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { httpDuration } from '../metrics/registry';

/** Times every API request by its route template (`/devices/:mac`), never by raw URL. */
const metricsPlugin: FastifyPluginAsync = async (app) => {
    app.addHook('onResponse', async (request, reply) => {
        httpDuration.observe({
            method: request.method,
            route: request.routeOptions?.url ?? 'unmatched',
            status: String(reply.statusCode),
        }, reply.elapsedTime / 1000);
    });
};

export default fp(metricsPlugin, { name: 'metrics-plugin' });
