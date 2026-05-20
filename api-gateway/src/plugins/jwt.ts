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
};

export default fp(jwtPlugin, {
    name: 'jwt-plugin',
});
