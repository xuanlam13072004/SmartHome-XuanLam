import assert from 'node:assert/strict';
import test from 'node:test';
import { forwardAdmin } from '../src/api/admin-proxy';

const config = { baseUrl: 'http://api-gateway:3000/', key: 'k'.repeat(40), timeoutMs: 1000 };

function recorder(status = 200, body: unknown = { success: true }) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
}

test('adds the server key and forwards path, query and body to the Gateway', async () => {
    const { calls, fetchImpl } = recorder(200, { success: true, total: 3 });
    const listed = await forwardAdmin({ method: 'GET', path: '/admin/accounts', search: '?q=lan&page=2' }, config, fetchImpl);
    assert.deepEqual(listed, { status: 200, body: { success: true, total: 3 } });
    assert.equal(calls[0].url, 'http://api-gateway:3000/admin/accounts?q=lan&page=2');
    assert.deepEqual(calls[0].init.headers, { 'x-admin-key': config.key });
    assert.equal(calls[0].init.body, undefined);

    await forwardAdmin({
        method: 'POST', path: '/admin/accounts/6f9c2d1e-0000-4000-8000-000000000001/disable', search: '', body: { reason: 'Spam' },
    }, config, fetchImpl);
    assert.equal(calls[1].init.method, 'POST');
    assert.equal((calls[1].init.headers as Record<string, string>)['content-type'], 'application/json');
    assert.equal(calls[1].init.body, JSON.stringify({ reason: 'Spam' }));
});

test('passes the Gateway answer through, errors included', async () => {
    const { fetchImpl } = recorder(409, { success: false, error: { code: 'ACCOUNT_NOT_ACTIVE', message: 'x' } });
    const result = await forwardAdmin({ method: 'POST', path: '/admin/accounts/a/disable', search: '', body: {} }, config, fetchImpl);
    assert.equal(result.status, 409);
    assert.equal((result.body as any).error.code, 'ACCOUNT_NOT_ACTIVE');
});

test('refuses without a key, outside /admin and when the Gateway is unreachable', async () => {
    const { calls, fetchImpl } = recorder();
    const missing = await forwardAdmin({ method: 'GET', path: '/admin/overview', search: '' }, { ...config, key: undefined }, fetchImpl);
    assert.equal(missing.status, 503);
    assert.equal((missing.body as any).error.code, 'ADMIN_NOT_CONFIGURED');
    for (const path of ['/auth/login', '/admin', '/admin/../auth/login', '/admin/a/b/c/d']) {
        assert.equal((await forwardAdmin({ method: 'GET', path, search: '' }, config, fetchImpl)).status, 404, path);
    }
    assert.equal((await forwardAdmin({ method: 'DELETE', path: '/admin/overview', search: '' }, config, fetchImpl)).status, 404);
    assert.equal(calls.length, 0, 'nothing reached the Gateway');

    const down = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch;
    const unreachable = await forwardAdmin({ method: 'GET', path: '/admin/overview', search: '' }, config, down);
    assert.equal(unreachable.status, 502);
    assert.equal((unreachable.body as any).error.code, 'ADMIN_GATEWAY_UNREACHABLE');
});
