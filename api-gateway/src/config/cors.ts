import type { FastifyCorsOptions } from '@fastify/cors';

/**
 * CORS for browser clients (Flutter web, tools). @fastify/cors allows only
 * GET, HEAD and POST unless told otherwise, and a browser then refuses every
 * PATCH / PUT / DELETE at the preflight (the app sees "cannot reach server").
 */
export const corsOptions: FastifyCorsOptions = {
    origin: true, // Allow all origins in dev
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
};
