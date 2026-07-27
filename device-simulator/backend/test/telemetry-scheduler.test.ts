import assert from 'node:assert/strict';
import test from 'node:test';
import { TelemetryScheduler } from '../src/runtime/telemetry-scheduler';

const waitUntil = async (
    predicate: () => boolean,
    timeoutMs: number = 1_000,
): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for scheduler state');
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
};

test('central scheduler enforces publish concurrency and keeps excess work due', async () => {
    const scheduler = new TelemetryScheduler(2);
    const releases: Array<() => void> = [];
    let active = 0;
    let maximumActive = 0;

    const register = (deviceId: string) => scheduler.register({
        deviceId,
        runId: 'run-test',
        intervalMs: 60_000,
        jitterPercent: 0,
        initialDelayMs: 0,
        publish: async () => {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            await new Promise<void>((resolve) => releases.push(resolve));
            active -= 1;
        },
    });

    register('device-1');
    register('device-2');
    register('device-3');
    await waitUntil(() => releases.length === 2);

    assert.equal(maximumActive, 2);
    assert.deepEqual(scheduler.getStats('run-test'), {
        registered: 3,
        active: 2,
        due: 1,
    });

    releases.shift()?.();
    await waitUntil(() => releases.length === 2);
    assert.equal(maximumActive, 2);

    for (const release of releases.splice(0)) release();
    scheduler.stop();
});

test('unregister removes a device from the central schedule', async () => {
    const scheduler = new TelemetryScheduler(1);
    scheduler.register({
        deviceId: 'device-1',
        runId: 'run-test',
        intervalMs: 60_000,
        jitterPercent: 0,
        initialDelayMs: 60_000,
        publish: async () => undefined,
    });
    scheduler.unregister('device-1');
    assert.deepEqual(scheduler.getStats(), {
        registered: 0,
        active: 0,
        due: 0,
    });
    scheduler.stop();
});
