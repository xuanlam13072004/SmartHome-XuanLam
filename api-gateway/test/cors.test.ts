import test from 'node:test';
import assert from 'node:assert/strict';
import fastify from 'fastify';
import cors from '@fastify/cors';
import { corsOptions } from '../src/config/cors';

test('browsers may call every REST verb the app uses', async () => {
    const app = fastify();
    await app.register(cors, corsOptions);
    app.patch('/rooms/:roomId', async () => ({ success: true }));
    await app.ready();
    try {
        for (const method of ['PATCH', 'PUT', 'DELETE']) {
            const preflight = await app.inject({
                method: 'OPTIONS',
                url: '/rooms/abc',
                headers: {
                    origin: 'http://localhost:5000',
                    'access-control-request-method': method,
                    'access-control-request-headers': 'authorization,content-type',
                },
            });
            assert.equal(preflight.statusCode, 204);
            assert.equal(preflight.headers['access-control-allow-origin'], 'http://localhost:5000');
            assert.match(String(preflight.headers['access-control-allow-methods']), new RegExp(`\\b${method}\\b`));
            assert.match(String(preflight.headers['access-control-allow-headers']), /authorization/i);
        }
    } finally {
        await app.close();
    }
});
