import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';
import { getMongoDb } from '../../infrastructure/mongodb/client';

const eventsRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
    app.get('/api/events', async (request) => {
        const query = request.query as {
            run_id?: string;
            mac?: string;
            limit?: string;
            /** `warning`: warnings and errors only (hides per-device info noise). */
            severity?: string;
        };
        const filter: Record<string, unknown> = {};
        if (query.severity === 'warning') filter.severity = { $in: ['warning', 'error'] };
        if (query.run_id) filter.run_id = query.run_id;
        if (query.mac) filter.mac = query.mac.trim().toUpperCase();
        const limit = Math.min(Math.max(Number(query.limit) || 100, 1), env.MAX_PAGE_SIZE);
        const events = await getMongoDb().collection('simulator_events')
            .find(filter)
            .sort({ created_at: -1 })
            .limit(limit)
            .toArray();
        return { success: true, events };
    });
};

export default eventsRoutes;
