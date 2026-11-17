import type { FastifyInstance } from 'fastify';
import { REDIS_CHANNELS } from '../../../../shared/constants';

/**
 * Tells every realtime instance to close the sockets of these login sessions
 * (or all of the account's). Access tokens of the sessions are already
 * rejected by `authenticate`; this only shortens the life of open sockets.
 */
export async function publishSessionsRevoked(
    app: FastifyInstance,
    accountId: string,
    sessionIds: string[] | 'all',
): Promise<void> {
    if (Array.isArray(sessionIds) && sessionIds.length === 0) return;
    try {
        await app.redis.publish(
            REDIS_CHANNELS.ACCOUNT_SESSIONS_REVOKED,
            JSON.stringify(sessionIds === 'all'
                ? { account_id: accountId, all: true }
                : { account_id: accountId, session_ids: sessionIds }),
        );
    } catch (error) {
        app.log.warn({ error, accountId }, 'Failed to announce revoked sessions');
    }
}
