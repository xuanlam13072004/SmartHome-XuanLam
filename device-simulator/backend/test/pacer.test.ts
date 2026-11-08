import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayPacer, TokenBucket } from '../src/generation/pacer';

const fakeClock = () => {
    let now = 0;
    const waits: number[] = [];
    return {
        now: () => now,
        wait: async (ms: number) => { waits.push(ms); now += ms; },
        waits,
    };
};

test('a bucket lets a full minute of requests through, then paces at the configured rate', async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(20, 20, clock.now, clock.wait);
    for (let index = 0; index < 20; index += 1) await bucket.take();
    assert.deepEqual(clock.waits, []);
    await bucket.take();
    await bucket.take();
    assert.deepEqual(clock.waits, [3000, 3000]);
});

test('callers are served in order and an aborted caller does not block the queue', async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(60, 1, clock.now, clock.wait);
    await bucket.take();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(bucket.take(controller.signal));
    await bucket.take();
    assert.deepEqual(clock.waits, [1000]);
});

test('claims are limited per account, so different accounts never wait for each other', async () => {
    const pacer = new GatewayPacer({ registerPerMinute: 20, loginPerMinute: 100, claimPerAccountPerMinute: 2 });
    const started = Date.now();
    await Promise.all(['a', 'b', 'c', 'd'].flatMap((account) => [pacer.claim(account), pacer.claim(account)]));
    assert.ok(Date.now() - started < 200);
});
