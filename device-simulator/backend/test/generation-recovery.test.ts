import assert from 'node:assert/strict';
import test from 'node:test';
import { GenerationQueue } from '../src/generation/queue';
import { apiGateway } from '../src/infrastructure/api-gateway/client';
import { encrypt } from '../src/security/crypto';

const logger = { child: () => logger, info() {}, warn() {}, error() {} } as any;
const matches = (row: any, filter: any): boolean => Object.entries(filter).every(([key, value]: [string, any]) => {
    if (value && typeof value === 'object') {
        if ('$type' in value) return typeof row[key] === value.$type;
        if ('$in' in value) return value.$in.includes(row[key]);
        if ('$ne' in value) return row[key] !== value.$ne;
        if ('$gte' in value) return row[key] >= value.$gte && row[key] < value.$lt;
    }
    return row[key] === value;
});
const update = (row: any, change: any) => {
    for (const [key, value] of Object.entries(change.$set || {})) {
        const parts = key.split('.');
        let target = row;
        for (const part of parts.slice(0, -1)) target = target[part] ||= {};
        target[parts[parts.length - 1]] = value;
    }
    for (const [key, value] of Object.entries(change.$inc || {})) row[key] = (row[key] || 0) + Number(value);
};

test('retry fills the missing 11 of 19 devices, skips completed users and clears partial despite historical errors', async t => {
    const run: any = { id: 'run', status: 'queued', config: { user_count: 6, cleanup_policy: 'manual' }, total_errors: 3, last_error: '429' };
    const users = [3, 5, 3, 3, 2, 3].map((target, index) => ({
        run_id: 'run', generation_index: index, account_id: `user${index}`,
        email: `user${index}@example.test`, credential: encrypt('isolated-test-password'),
        account_created_by_simulator: true, target_device_count: target,
        generation_state: index < 3 ? 'failed' : 'ready', status: index < 3 ? 'failed' : 'active',
    }));
    const devices: any[] = users.slice(3).flatMap(user => Array.from({ length: user.target_device_count }, (_, index) => ({
        run_id: 'run', simulator_user_id: user.account_id, generation_index: index, provisioning_state: 'claimed',
    })));
    const originalDevices = [...devices];
    const db = { collection: (name: string) => {
        const rows: any[] = name === 'simulation_runs' ? [run] : name === 'simulated_users' ? users : devices;
        return {
            findOne: async (filter: any) => rows.find(row => matches(row, filter)) || null,
            countDocuments: async (filter: any) => rows.filter(row => matches(row, filter)).length,
            updateOne: async (filter: any, change: any) => { const row = rows.find(row => matches(row, filter)); if (row) update(row, change); },
            updateMany: async (filter: any, change: any) => { rows.filter(row => matches(row, filter)).forEach(row => update(row, change)); },
            aggregate: () => ({ next: async () => name === 'simulated_users'
                ? { total: users.reduce((sum, user) => sum + user.target_device_count, 0) }
                : { devices_requested: devices.length, devices_provisioned: devices.length, devices_claimed: devices.length } }),
        };
    } } as any;
    const logins: string[] = [];
    t.mock.method(apiGateway, 'login', async (input: any) => {
        logins.push(input.email);
        return { accessToken: 'test-access', refreshToken: 'test-refresh', sessionId: 'test-session' };
    });
    const queue = new GenerationQueue(logger, () => db);
    // Only external provisioning/event persistence are substituted; queue/resume logic runs unchanged.
    (queue as any).safeEvent = async () => {};
    (queue as any).ensureDevice = async (_run: any, input: any) => {
        if (!devices.some(d => d.simulator_user_id === input.accountId && d.generation_index === input.deviceIndex)) {
            devices.push({ run_id: 'run', simulator_user_id: input.accountId, generation_index: input.deviceIndex, provisioning_state: 'claimed' });
        }
    };
    await queue.startRun(run);
    // Users are generated in parallel lanes; only the set of logins matters.
    assert.deepEqual([...logins].sort(), ['user0@example.test', 'user1@example.test', 'user2@example.test']);
    assert.equal(devices.length, 19);
    assert.ok(originalDevices.every(device => devices.includes(device)));
    assert.equal(run.status, 'completed');
    assert.equal(run.last_error, null);
    assert.equal(run.total_errors, 3); // history remains available
    assert.equal(run.progress.devices_claimed, 19);
    assert.ok(users.every(user => user.generation_state === 'ready'));
    // A delayed start after an explicit pause must not restart generation.
    run.status = 'paused';
    await queue.startRun(run);
    assert.equal(run.status, 'paused');
    assert.equal(logins.length, 3);
});
