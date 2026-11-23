import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../../config/env';
import { forwardAdmin } from '../admin-proxy';

/** /api/admin/* → the API Gateway's /admin/* (docs/architecture/admin.md). */
const adminRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
    const handle = async (request: FastifyRequest, reply: FastifyReply) => {
        const url = request.raw.url ?? '';
        const query = url.indexOf('?');
        const pathname = query === -1 ? url : url.slice(0, query);
        const result = await forwardAdmin(
            {
                method: request.method,
                path: pathname.replace(/^\/api(?=\/admin\/)/, ''),
                search: query === -1 ? '' : url.slice(query),
                body: request.body,
            },
            { baseUrl: env.API_GATEWAY_URL, key: env.ADMIN_API_KEY, timeoutMs: env.API_REQUEST_TIMEOUT_MS },
        );
        reply.header('Cache-Control', 'no-store');
        return reply.status(result.status).send(result.body);
    };
    app.get('/api/admin/*', handle);
    app.post('/api/admin/*', handle);
};

export default adminRoutes;
