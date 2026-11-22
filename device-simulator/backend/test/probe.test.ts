import assert from 'node:assert/strict';
import test from 'node:test';
import {
    latencyStats,
    pickProbeCommand,
    probeCsv,
    type ProbeDeps,
    ProbeRun,
    summarize,
} from '../src/workload/probe';
import { tokenSecondsLeft } from '../src/workload/probe-service';

test('probe commands are safe to repeat and answered at once when possible', () => {
    const entrance = pickProbeCommand({
        'main_lock.unlock': { instance_id: 'main_lock', risk: 'sensitive', confirmation: 'confirm', idempotent: true },
        'lcd.set_custom_message': { instance_id: 'lcd', risk: 'normal', idempotent: true, input: { lines: {} } },
        'main_lock.lock': { instance_id: 'main_lock', risk: 'normal', confirmation: 'none', idempotent: true },
    });
    assert.deepEqual(entrance, { instance_id: 'main_lock', operation_name: 'lock', input: {} });
    const roof = pickProbeCommand({
        'roof_motor.open': { instance_id: 'roof_motor', risk: 'normal', idempotent: true, ack_policy: { completion_signal: 'motion_completed' } },
        'roof_motor.close': { instance_id: 'roof_motor', risk: 'normal', idempotent: true },
    });
    assert.equal(roof?.operation_name, 'close', 'a command that waits for the motor comes last');
    assert.deepEqual(pickProbeCommand({
        'alarm_siren.mute_siren': { instance_id: 'alarm_siren', risk: 'normal', idempotent: true, input: { duration_seconds: { default: 60 } } },
    })?.input, { duration_seconds: 60 });
    assert.equal(pickProbeCommand({ 'pump.water': { instance_id: 'pump', risk: 'normal', idempotent: false } }), null);
});

test('latency percentiles, errors and throughput', () => {
    const stats = latencyStats(Array.from({ length: 100 }, (_, index) => index + 1))!;
    assert.deepEqual([stats.p50_ms, stats.p95_ms, stats.p99_ms, stats.max_ms, stats.mean_ms], [50, 95, 99, 100, 50.5]);
    assert.equal(latencyStats([]), null);
    const summary = summarize([
        { at: 0, ms: 10, ok: true, server_ms: 5 },
        { at: 1, ms: 30, ok: true, server_ms: 7 },
        { at: 2, ms: 5, ok: false, code: 'HTTP_429' },
    ], 2000);
    assert.deepEqual(summary.totals, { requests: 3, ok: 2, failed: 1 });
    assert.deepEqual(summary.errors, { HTTP_429: 1 });
    assert.equal(summary.throughput_per_second, 1.5);
    assert.equal(summary.latency?.max_ms, 30, 'failed requests do not count in latency');
    assert.equal(summary.server?.p50_ms, 5);
});

/** A fake API and operation table on a fake clock: commands finish 100 ms after they are sent. */
function fakeDeps(options: { users: number; devicesFail?: string; neverFinish?: string } ) {
    let clock = 1_000_000;
    let counter = 0;
    const sent = new Map<string, number>();
    const requests: string[] = [];
    const deps: ProbeDeps = {
        users: async (kind, limit) => Array.from({ length: Math.min(limit, options.users) }, (_, index) => ({
            account_id: `user-${index}`,
            devices: kind === 'commands'
                ? [{ mac: `AA:00:00:00:00:0${index}`, command: { instance_id: 'main_lock', operation_name: 'lock', input: {} } }]
                : [],
        })),
        accessToken: async accountId => `token-${accountId}`,
        request: async (path, init) => {
            const start = clock;
            clock += 20;
            path = decodeURIComponent(path);
            requests.push(`${init.method} ${path}`);
            if (options.devicesFail && path.includes(options.devicesFail)) {
                return { status: 429, body: { error: { code: 'RATE_LIMITED' } } };
            }
            if (init.method === 'GET') return { status: 200, body: { success: true } };
            counter += 1;
            const id = path.includes(options.neverFinish ?? '-') ? `never-${counter}` : `op-${counter}`;
            sent.set(id, start);
            return { status: 200, body: { success: true, operation_id: id, status: 'queued' } };
        },
        finished: async ids => ids
            .filter(id => !id.startsWith('never') && clock - sent.get(id)! >= 100)
            .map(id => ({
                id, status: 'succeeded',
                accepted_at: new Date(sent.get(id)! + 10), completed_at: new Date(sent.get(id)! + 100),
            })),
        context: () => ({ devices_connected: 3, telemetry_per_second: 12.5 }),
        now: () => clock,
        sleep: async ms => {
            clock += ms;
            await new Promise(resolve => setImmediate(resolve));
        },
    };
    return { deps, requests };
}

test('a commands probe measures from the request to the device result, through the public API', async () => {
    const { deps, requests } = fakeDeps({ users: 3, devicesFail: 'AA:00:00:00:00:02', neverFinish: 'AA:00:00:00:00:01' });
    const run = new ProbeRun(deps, { kind: 'commands', users: 3, per_user: 2, concurrency: 3 });
    const result = await run.run();
    assert.equal(result.status, 'completed');
    assert.equal(result.users_used, 3);
    assert.deepEqual(result.context, { devices_connected: 3, telemetry_per_second: 12.5 });
    assert.ok(requests.every(line => line.startsWith('POST /devices/')), 'commands go through the Gateway API');
    assert.deepEqual(result.totals, { requests: 6, ok: 2, failed: 4 });
    assert.deepEqual(result.errors, { RATE_LIMITED: 2, no_result_30s: 2 });
    assert.equal(result.latency?.p50_ms, 100);
    assert.equal(result.server?.p50_ms, 90);
    assert.ok(result.finished_at);
    assert.match(probeCsv(result), /^at_ms,latency_ms,server_ms,ok,code,request\n/);
});

test('an app probe times each read; no users or a stop end it cleanly', async () => {
    const { deps, requests } = fakeDeps({ users: 2 });
    const reads = await new ProbeRun(deps, { kind: 'app_reads', users: 2, per_user: 1, concurrency: 2 }).run();
    assert.equal(reads.totals.requests, 6);
    assert.deepEqual([...new Set(reads.samples.map(sample => sample.what))].sort(), ['/devices', '/me/badges', '/me/notifications']);
    assert.ok(requests.every(line => line.startsWith('GET ')));

    const empty = await new ProbeRun(fakeDeps({ users: 0 }).deps, { kind: 'commands', users: 5, per_user: 1, concurrency: 1 }).run();
    assert.equal(empty.status, 'failed');
    assert.match(empty.note ?? '', /Không có người dùng ảo/);

    const stopped = new ProbeRun(fakeDeps({ users: 4 }).deps, { kind: 'commands', users: 4, per_user: 20, concurrency: 1 });
    const done = stopped.run();
    await new Promise(resolve => setImmediate(resolve));
    stopped.cancel();
    const result = await done;
    assert.equal(result.status, 'stopped');
    assert.ok(result.totals.requests < 80);
});

test('access tokens are refreshed shortly before they expire', () => {
    const token = (exp: number) => `x.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.y`;
    assert.equal(tokenSecondsLeft(token(1_000_600), 1_000_000_000), 600);
    assert.equal(tokenSecondsLeft('not-a-token'), 0);
});
