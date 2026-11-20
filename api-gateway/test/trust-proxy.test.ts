import './setup-env';
import test from 'node:test';
import assert from 'node:assert/strict';
import fastify from 'fastify';
import { trustProxyOption } from '../src/config/trustProxy';

// cloudflared on the same computer reaches the Gateway through Docker's port
// publishing, so the socket address is loopback or a private Docker address.
async function ipSeen(trust: string, remoteAddress: string, forwardedFor?: string) {
    const app = fastify({ trustProxy: trustProxyOption(trust) });
    app.get('/ip', async (request) => ({ ip: request.ip }));
    const response = await app.inject({
        method: 'GET',
        url: '/ip',
        remoteAddress,
        headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
    });
    await app.close();
    return response.json().ip as string;
}

const DOCKER = 'loopback,linklocal,uniquelocal';

test('empty TRUST_PROXY trusts nobody', async () => {
    assert.equal(trustProxyOption(''), false);
    assert.equal(trustProxyOption(' , '), false);
    assert.deepEqual(trustProxyOption('loopback, 10.0.0.0/8'), ['loopback', '10.0.0.0/8']);
    assert.equal(await ipSeen('', '172.18.0.1', '203.0.113.7'), '172.18.0.1');
});

test('through the tunnel every visitor keeps its own address', async () => {
    assert.equal(await ipSeen(DOCKER, '172.18.0.1', '203.0.113.7'), '203.0.113.7');
    assert.equal(await ipSeen(DOCKER, '127.0.0.1', '198.51.100.20'), '198.51.100.20');
    // Cloudflare appends the real visitor after whatever the visitor sent.
    assert.equal(await ipSeen(DOCKER, '172.18.0.1', '10.0.0.5, 203.0.113.7'), '203.0.113.7');
    assert.equal(await ipSeen(DOCKER, '172.18.0.1', '1.2.3.4, 203.0.113.7'), '203.0.113.7');
    // No header (emulator, containers): the socket address.
    assert.equal(await ipSeen(DOCKER, '172.18.0.1'), '172.18.0.1');
});

test('a public client cannot choose its address', async () => {
    assert.equal(await ipSeen(DOCKER, '203.0.113.9', '1.2.3.4'), '203.0.113.9');
});
