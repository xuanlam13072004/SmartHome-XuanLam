import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import { WebSocket, WebSocketServer } from 'ws';
import { env } from '../src/config/env.js';
import { handleConnection } from '../src/handlers/wsHandler.js';
import { AccessTokenRejectedError, verifyAccessToken } from '../src/services/accessTokenVerifier.js';

const realFetch = globalThis.fetch;
type GatewayReply = { status: number; userId?: string } | 'unreachable';
let gatewayReply: GatewayReply = { status: 200 };

test.beforeEach(() => {
    gatewayReply = { status: 200 };
    globalThis.fetch = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
        if (gatewayReply === 'unreachable') throw new Error('ECONNREFUSED');
        const token = String(init?.headers?.Authorization || '').replace('Bearer ', '');
        const claims = jwt.decode(token) as { userId: string };
        return new Response(JSON.stringify({ success: true, user: { id: gatewayReply.userId ?? claims.userId } }), {
            status: gatewayReply.status,
        });
    }) as typeof fetch;
});
test.after(() => { globalThis.fetch = realFetch; });

const sign = (claims: object, expiresIn: number) => jwt.sign(claims, env.JWT_SECRET, { expiresIn });

test('accepts an active account token', async () => {
    const access = await verifyAccessToken(sign({ userId: 'u1' }, 60));
    assert.equal(access.userId, 'u1');
    assert.ok(access.expiresAtMs > Date.now());
});

test('rejects a token the Gateway reports as revoked (token_version/status)', async () => {
    gatewayReply = { status: 401 };
    await assert.rejects(verifyAccessToken(sign({ userId: 'u1' }, 60)), AccessTokenRejectedError);
});

test('rejects forged, purpose-scoped and subject-mismatched tokens', async () => {
    await assert.rejects(verifyAccessToken(jwt.sign({ userId: 'u1' }, 'wrong-secret-value', { expiresIn: 60 })), AccessTokenRejectedError);
    await assert.rejects(verifyAccessToken(sign({ userId: 'u1', purpose: 'reauth' }, 60)), AccessTokenRejectedError);
    gatewayReply = { status: 200, userId: 'someone-else' };
    await assert.rejects(verifyAccessToken(sign({ userId: 'u1' }, 60)), AccessTokenRejectedError);
});

test('fails closed when the Gateway is unreachable', async () => {
    gatewayReply = 'unreachable';
    await assert.rejects(verifyAccessToken(sign({ userId: 'u1' }, 60)), (error: Error) => (
        !(error instanceof AccessTokenRejectedError) && /unavailable/.test(error.message)
    ));
});

async function withServer(run: (url: string) => Promise<void>) {
    const server = http.createServer();
    const wss = new WebSocketServer({ server, path: '/ws' });
    wss.on('connection', handleConnection);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        await run(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`);
    } finally {
        for (const client of wss.clients) client.terminate();
        await new Promise(resolve => wss.close(resolve));
        await new Promise(resolve => server.close(resolve));
    }
}

function collect(socket: WebSocket) {
    const events: string[] = [];
    socket.on('message', data => events.push(JSON.parse(String(data)).event));
    const closed = new Promise<number>(resolve => socket.on('close', code => resolve(code)));
    return { events, closed };
}

test('socket is closed when the access token expires', async () => {
    await withServer(async (url) => {
        const socket = new WebSocket(url);
        const { events, closed } = collect(socket);
        await new Promise(resolve => socket.once('open', resolve));
        socket.send(JSON.stringify({ event: 'auth', payload: { token: sign({ userId: 'u1' }, 2) } }));
        const code = await closed;
        assert.ok(events.includes('auth_success'), `events: ${events}`);
        assert.ok(events.includes('token_expired'), `events: ${events}`);
        assert.equal(code, 4001);
    });
});

test('revoked account cannot open a realtime channel', async () => {
    gatewayReply = { status: 401 };
    await withServer(async (url) => {
        const socket = new WebSocket(url);
        const { events, closed } = collect(socket);
        await new Promise(resolve => socket.once('open', resolve));
        socket.send(JSON.stringify({ event: 'auth', payload: { token: sign({ userId: 'u1' }, 60) } }));
        assert.equal(await closed, 4001);
        assert.ok(!events.includes('auth_success'));
    });
});
