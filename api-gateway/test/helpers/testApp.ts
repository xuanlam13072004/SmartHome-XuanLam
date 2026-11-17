import fastify, { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { Db, MongoClient } from 'mongodb';
import fp from 'fastify-plugin';
import type { Pool } from 'pg';
// @ts-ignore - test double without type declarations
import RedisMock from 'ioredis-mock';
import errorHandlerPlugin from '../../src/plugins/errorHandler';
import validationPlugin from '../../src/plugins/validation';
import jwtPlugin from '../../src/plugins/jwt';
import rateLimitPlugin from '../../src/plugins/rateLimit';
import authRoutes from '../../src/modules/auth/routes';
import { RuntimeCatalog } from '../../../shared/catalog-v2';

/** A Gateway with the real auth, validation, rate-limit and error plugins on a test database. */
export async function buildTestApp(
    pool: Pool,
    routes: FastifyPluginAsync[] = [],
    mongo?: { client: MongoClient; db: Db },
): Promise<FastifyInstance> {
    const app = fastify({ logger: false });
    if (mongo) app.decorate('mongo', mongo);
    await app.register(errorHandlerPlugin);
    await app.register(validationPlugin);
    app.decorate('pg', pool);
    await app.register(fp(async (instance) => {
        instance.decorate('redis', new RedisMock());
    }, { name: 'redis-plugin' }));
    // The real published catalog (product permissions drive sharing presets).
    app.decorate('catalog', await new RuntimeCatalog({ log: { info: () => undefined } }).start());
    await app.register(jwtPlugin);
    await app.register(rateLimitPlugin);
    await app.register(authRoutes);
    for (const route of routes) await app.register(route);
    await app.ready();
    return app;
}

/** Captures Redis publications (channel + parsed JSON) made by the app from now on. */
export function recordPublishes(app: FastifyInstance): Array<{ channel: string; payload: any }> {
    const published: Array<{ channel: string; payload: any }> = [];
    const original = app.redis.publish.bind(app.redis);
    (app.redis as any).publish = async (channel: string, message: string) => {
        published.push({ channel, payload: JSON.parse(message) });
        return original(channel, message);
    };
    return published;
}

export interface SignedInUser {
    id: string;
    email: string;
    password: string;
    accessToken: string;
    refreshToken: string;
    sessionId: string;
    headers: { authorization: string };
}

let counter = 0;

/** Registers a fresh account and signs it in through the public API. */
export async function signUp(app: FastifyInstance, overrides: { email?: string; fullName?: string } = {}): Promise<SignedInUser> {
    counter += 1;
    const email = overrides.email ?? `user${counter}.${Date.now()}@example.com`;
    const password = 'correct horse battery';
    const register = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email, password, full_name: overrides.fullName ?? `Người dùng ${counter}` },
    });
    if (register.statusCode !== 200) throw new Error(`register failed: ${register.body}`);
    return signIn(app, email, password);
}

export async function signIn(
    app: FastifyInstance,
    email: string,
    password: string,
    client?: { platform?: string; name?: string },
): Promise<SignedInUser> {
    const login = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password, ...(client ? { client } : {}) },
    });
    if (login.statusCode !== 200) throw new Error(`login failed: ${login.body}`);
    const body = login.json();
    return {
        id: body.user.id,
        email,
        password,
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        sessionId: body.session_id,
        headers: { authorization: `Bearer ${body.access_token}` },
    };
}
