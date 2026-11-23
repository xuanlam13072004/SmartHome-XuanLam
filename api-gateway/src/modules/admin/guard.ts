import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../../config/env';
import { ipKey } from '../../plugins/rateLimit';
import { httpError } from '../../utils/httpError';

/**
 * Who may call /admin/*: only a server holding ADMIN_API_KEY (the Simulator's
 * backend, inside the Docker network). No customer token is accepted here.
 * - no key configured → the API does not exist (404);
 * - a request that came through Cloudflare Tunnel → refused, whatever key it
 *   carries: the administration API is never reachable from the Internet;
 * - wrong key → 401, and repeated wrong keys from one address are slowed down.
 */

/** Cloudflare adds these to every request it forwards through the tunnel. */
const TUNNEL_HEADERS = ['cf-ray', 'cf-connecting-ip'] as const;

export function cameThroughTunnel(headers: Record<string, unknown>): boolean {
    return TUNNEL_HEADERS.some(name => headers[name] !== undefined);
}

/** Constant-time comparison of the presented key with the configured one. */
export function adminKeyMatches(presented: unknown, configured: string): boolean {
    if (typeof presented !== 'string' || configured === '') return false;
    const left = crypto.createHash('sha256').update(presented).digest();
    const right = crypto.createHash('sha256').update(configured).digest();
    return crypto.timingSafeEqual(left, right);
}

export const ADMIN_KEY_HEADER = 'x-admin-key';
const WRONG_KEYS_PER_MINUTE = 20;

export function adminGuard(app: FastifyInstance) {
    const countWrongKey = app.limitBy('admin-key', ipKey, WRONG_KEYS_PER_MINUTE);
    return async (request: FastifyRequest, reply: FastifyReply) => {
        if (!env.ADMIN_API_KEY) throw httpError(404, 'NOT_FOUND', 'Not found');
        if (cameThroughTunnel(request.headers)) {
            throw httpError(403, 'ADMIN_INTERNAL_ONLY', 'The administration API is only reachable inside the server network');
        }
        if (!adminKeyMatches(request.headers[ADMIN_KEY_HEADER], env.ADMIN_API_KEY)) {
            await countWrongKey(request, reply);
            throw httpError(401, 'ADMIN_KEY_INVALID', 'Invalid administration key');
        }
    };
}
