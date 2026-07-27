import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { simulatorEvents } from '../../events/service';

const streamRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
    app.get('/api/events/stream', (request, reply) => {
        reply.hijack();
        reply.raw.setHeader('Content-Type', 'text/event-stream');
        reply.raw.setHeader('Cache-Control', 'no-cache');
        reply.raw.setHeader('Connection', 'keep-alive');
        reply.raw.flushHeaders();

        reply.raw.write(`event: connected\ndata: ${JSON.stringify({ type: 'connected' })}\n\n`);

        const listener = (event: unknown) => {
            reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        };

        simulatorEvents.on('event', listener);
        const heartbeat = setInterval(() => {
            reply.raw.write(': heartbeat\n\n');
        }, 15000);

        request.raw.on('close', () => {
            clearInterval(heartbeat);
            simulatorEvents.off('event', listener);
            reply.raw.end();
        });
    });
};

export default streamRoutes;
