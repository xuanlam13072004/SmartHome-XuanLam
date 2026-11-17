import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import { env } from '../config/env';
import { UUID_PATTERN } from '../modules/auth/tokens';
import { httpError } from '../utils/httpError';

/**
 * jwtPlugin
 * - Register JWT support for auth and protected routes
 * - Adds app.jwt and request.jwtVerify()
 */
const jwtPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
    app.register(fastifyJwt, {
        secret: env.JWT_SECRET,
        sign: {
            expiresIn: env.JWT_EXPIRES_IN,
        },
    });

    /**
     * Protected routes accept an access token only while its account is active,
     * its token_version is current (bumped by a password change) and its login
     * session has not been signed out or expired. One primary-key lookup.
     */
    app.decorate('authenticate', async (request, _reply) => {
        await request.jwtVerify();
        const claims = request.user as { userId?: unknown; sid?: unknown; purpose?: unknown; tokenVersion?: unknown };
        if (
            typeof claims.userId !== 'string'
            || claims.purpose
            || typeof claims.sid !== 'string'
            || !UUID_PATTERN.test(claims.userId)
            || !UUID_PATTERN.test(claims.sid)
        ) {
            throw httpError(401, 'INVALID_ACCESS_TOKEN', 'Invalid access token');
        }
        const result = await app.pg.query(
            `SELECT account.status, account.token_version,
                    session.status = 'active' AND session.expires_at > NOW() AS session_active
             FROM accounts AS account
             LEFT JOIN user_sessions AS session
               ON session.id = $2 AND session.account_id = account.id
             WHERE account.id = $1`,
            [claims.userId, claims.sid],
        );
        const row = result.rows[0];
        if (!row || row.status !== 'active'
            || Number(row.token_version) !== Number(claims.tokenVersion)
            || row.session_active !== true) {
            throw httpError(401, 'ACCESS_TOKEN_REVOKED', 'Access token has been revoked');
        }
    });
};

export default fp(jwtPlugin, {
    name: 'jwt-plugin',
});
