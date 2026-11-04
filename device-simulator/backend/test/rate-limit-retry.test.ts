import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchWithRateLimitRetry, retryDelayMs } from '../src/infrastructure/api-gateway/rate-limit-retry';
import { GenerationTaskLifecycle } from '../src/generation/task-lifecycle';

test('429 waits for Retry-After then replays the same request once', async () => {
    const requests: RequestInit[] = [];
    const waits: number[] = [];
    const notifications: string[] = [];
    const response = await fetchWithRateLimitRetry('http://gateway/auth/login', { method: 'POST', body: 'test-body' }, {
        timeoutMs: 1000,
        fetch: (async (_url, init) => {
            requests.push(init!);
            return requests.length === 1
                ? new Response('{"message":"Rate limit exceeded"}', { status: 429, headers: { 'Retry-After': '26' } })
                : Response.json({ success: true });
        }) as typeof fetch,
        wait: async ms => { waits.push(ms); },
        onRateLimit: info => { notifications.push(info.path); },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(waits, [26250]);
    assert.deepEqual(notifications, ['/auth/login']);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].body, requests[0].body);
});

test('retry delay accepts HTTP date, Fastify message and conservative fallback', () => {
    const now = Date.parse('2026-10-13T00:00:00Z');
    assert.equal(retryDelayMs(new Headers({ 'retry-after': 'Tue, 13 Oct 2026 00:00:13 GMT' }), '', now), 13250);
    assert.equal(retryDelayMs(new Headers(), '{"message":"Rate limit exceeded, retry in 1 second"}', now), 1250);
    assert.equal(retryDelayMs(new Headers(), '', now), 60250);
});

test('retry budget is bounded and 401/500/network failures are not replayed', async () => {
    for (const status of [429, 401, 500]) {
        let calls = 0;
        const response = await fetchWithRateLimitRetry('http://gateway/auth/login', {}, {
            timeoutMs: 1000, maxRetries: 2, wait: async () => {},
            fetch: (async () => { calls++; return new Response('error', { status }); }) as typeof fetch,
        });
        assert.equal(response.status, status);
        assert.equal(calls, status === 429 ? 3 : 1);
    }
    let calls = 0;
    await assert.rejects(fetchWithRateLimitRetry('http://gateway/auth/register', {}, {
        timeoutMs: 1000, fetch: (async () => { calls++; throw new Error('network lost'); }) as typeof fetch,
    }), /network lost/);
    assert.equal(calls, 1);
});

test('pause interrupts the throttle wait and resume gets a fresh signal', async () => {
    const tasks = new GenerationTaskLifecycle();
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    let calls = 0;
    const running = tasks.run('run', () => fetchWithRateLimitRetry('http://gateway/auth/login', {}, {
        timeoutMs: 1000, signal: tasks.signal('run'),
        fetch: (async () => { calls++; return new Response('limited', { status: 429 }); }) as typeof fetch,
        onRateLimit: () => entered(),
    }).then(() => undefined));
    const rejected = assert.rejects(running, { name: 'AbortError' });
    await waiting;
    await tasks.stop('run');
    await rejected;
    assert.equal(calls, 1);
    await tasks.run('run', async () => assert.equal(tasks.signal('run')?.aborted, false));
});
