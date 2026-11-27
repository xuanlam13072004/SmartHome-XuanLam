import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectScheduler, isLoginRefused, retryDelayMs, type ConnectTarget } from '../src/runtime/connect-scheduler';

const logger = { child: () => logger, debug() {}, info() {}, warn() {}, error() {} } as any;
const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const target = (mac: string, connect: () => Promise<void>, wants = () => true): ConnectTarget => ({
    mac, connect, wantsConnection: wants,
});

test('a refused login is recognised by its CONNACK code or message; network errors are not', () => {
    assert.equal(isLoginRefused(Object.assign(new Error('Connection refused: Not authorized'), { code: 5 })), true);
    assert.equal(isLoginRefused(Object.assign(new Error('x'), { code: 134 })), true);
    assert.equal(isLoginRefused(new Error('Connection refused: Bad username or password')), true);
    assert.equal(isLoginRefused(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })), false);
    assert.equal(isLoginRefused(new Error('connack timeout')), false);
});

test('retries wait 5 s, 10 s, 20 s… up to 5 minutes, each spread ±30 %', () => {
    assert.equal(retryDelayMs(1, () => 0.5), 5000);
    assert.equal(retryDelayMs(2, () => 0.5), 10_000);
    assert.equal(retryDelayMs(3, () => 0.5), 20_000);
    assert.equal(retryDelayMs(20, () => 0.5), 300_000);
    assert.equal(retryDelayMs(1, () => 0), 3500);
    assert.equal(retryDelayMs(1, () => 1), 6500);
});

test('connections start at the configured rate and never more than the concurrency cap at once', async () => {
    const scheduler = new ConnectScheduler(logger, 40, 3);
    let open = 0;
    let peak = 0;
    const started: number[] = [];
    const begin = Date.now();
    for (let index = 0; index < 12; index += 1) {
        scheduler.submit(target(`AA:00:00:00:00:${index}`, async () => {
            started.push(Date.now() - begin);
            open += 1;
            peak = Math.max(peak, open);
            await tick(20);
            open -= 1;
        }));
    }
    while (scheduler.stats().connected_total < 12) await tick(10);
    scheduler.stop();
    assert.ok(peak <= 3, `at most 3 waiting for CONNACK, saw ${peak}`);
    // 40 per second with a full bucket of 40: the 12 go as fast as the cap allows.
    assert.equal(started.length, 12);

    const slow = new ConnectScheduler(logger, 10, 100);
    const slowStarts: number[] = [];
    const slowBegin = Date.now();
    for (let index = 0; index < 15; index += 1) {
        slow.submit(target(`BB:00:00:00:00:${index}`, async () => { slowStarts.push(Date.now() - slowBegin); }));
    }
    while (slow.stats().connected_total < 15) await tick(10);
    slow.stop();
    // A bucket of 10, then one every 100 ms: the 15th starts about half a second in.
    assert.ok(slowStarts[14] >= 400, `15th connection started at ${slowStarts[14]} ms`);
});

test('a failed connection is retried later without blocking others; a refused login is reported, not retried', async () => {
    const scheduler = new ConnectScheduler(logger, 100, 10);
    const refused: string[] = [];
    scheduler.setRefusedListener(mac => refused.push(mac));
    let flaky = 0;
    let rejected = 0;
    let healthy = 0;
    scheduler.submit(target('AA:00:00:00:00:01', async () => {
        flaky += 1;
        throw new Error('connack timeout');
    }));
    scheduler.submit(target('AA:00:00:00:00:02', async () => {
        rejected += 1;
        throw Object.assign(new Error('Connection refused: Not authorized'), { code: 5 });
    }));
    scheduler.submit(target('AA:00:00:00:00:03', async () => { healthy += 1; }));
    while (scheduler.stats().connected_total + scheduler.stats().refused_total < 2) await tick(5);
    const stats = scheduler.stats();
    assert.equal(healthy, 1);
    assert.equal(rejected, 1);
    assert.deepEqual(refused, ['AA:00:00:00:00:02']);
    assert.equal(flaky, 1);
    assert.equal(stats.retrying, 1, 'the timed-out device waits for its retry');
    assert.equal(stats.failed_attempts_total, 1);

    // Submitting a device again while it waits does not add a second attempt.
    scheduler.submit(target('AA:00:00:00:00:01', async () => { flaky += 100; }));
    assert.equal(scheduler.stats().queued, 0);
    // Forgetting it (stopped, unpaired, cleaned) drops the retry.
    scheduler.forget('AA:00:00:00:00:01');
    assert.equal(scheduler.stats().retrying, 0);
    scheduler.stop();
});

test('devices removed or switched off before their turn are dropped from the queue, using no slot', async () => {
    const scheduler = new ConnectScheduler(logger, 2, 1);
    let connected = 0;
    scheduler.submit(target('AA:00:00:00:00:01', async () => { connected += 1; }));
    scheduler.submit(target('AA:00:00:00:00:02', async () => { connected += 1; }, () => false));
    scheduler.submit(target('AA:00:00:00:00:03', async () => { connected += 1; }));
    scheduler.forget('AA:00:00:00:00:03');
    await tick(50);
    assert.equal(connected, 1);
    // Dropped when its turn comes (at the next token), without connecting.
    await tick(600);
    assert.equal(connected, 1);
    assert.equal(scheduler.stats().queued, 0);
    scheduler.stop();
});
