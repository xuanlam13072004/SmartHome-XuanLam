import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import { env } from '../config/env';

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

    // Decorator dùng cho route protected
    app.decorate('authenticate', async (request, _reply) => {
        await request.jwtVerify();
        const claims = request.user as any;
        if (!claims.userId || claims.purpose) {
            const error = new Error('Invalid access token') as any;
            error.statusCode = 401;
            error.code = 'INVALID_ACCESS_TOKEN';
            throw error;
        }
        const account = await app.pg.query(
            'SELECT status, token_version FROM accounts WHERE id = $1',
            [claims.userId],
        );
        const row = account.rows[0];
        if (!row || row.status !== 'active'
            || Number(row.token_version) !== Number(claims.tokenVersion)) {
            const error = new Error('Access token has been revoked') as any;
            error.statusCode = 401;
            error.code = 'ACCESS_TOKEN_REVOKED';
            throw error;
        }
    });
};

export default fp(jwtPlugin, {
    name: 'jwt-plugin',
});
