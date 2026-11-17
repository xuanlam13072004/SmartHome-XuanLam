import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * True when the request carries a valid `X-Reauth-Token` from
 * POST /auth/reauthenticate for the signed-in account (password confirmed
 * moments ago). Required by operations whose catalog confirmation is
 * `reauthenticate` and by scenes with protected steps.
 */
export function hasRecentReauthentication(app: FastifyInstance, request: FastifyRequest): boolean {
    const token = request.headers['x-reauth-token'];
    if (typeof token !== 'string') return false;
    try {
        const confirmation = app.jwt.verify(token) as { purpose?: string; userId?: string };
        return confirmation.purpose === 'reauth'
            && confirmation.userId === (request.user as { userId: string }).userId;
    } catch {
        return false;
    }
}
