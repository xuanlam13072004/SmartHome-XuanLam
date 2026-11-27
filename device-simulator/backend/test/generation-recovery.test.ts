import assert from 'node:assert/strict';
import test from 'node:test';
import { GenerationQueue } from '../src/generation/queue';
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

test('retry fills the missing 11 of 19 devices, skips completed users and clears partial despite historical errors', async () => {
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
    const sessions: string[] = [];
    const queue = new GenerationQueue(logger, () => db, 8, undefined, {
        accessToken: async (user: any) => { sessions.push(user.email); return 'test-access'; },
        signIn: async () => { throw new Error('accounts already exist: no sign-in for recovery'); },
    } as any);
    // Only the steps that talk to the system are substituted; queue/resume logic runs unchanged.
    (queue as any).safeEvent = async () => {};
    (queue as any).planDevices = async (_run: any, user: any, accountId: string) => {
        for (let index = 0; index < user.target_device_count; index += 1) {
            if (!devices.some(d => d.simulator_user_id === accountId && d.generation_index === index)) {
                devices.push({ run_id: 'run', simulator_user_id: accountId, generation_index: index, provisioning_state: 'planned', mac: `${accountId}-${index}` });
            }
        }
        return devices.filter(d => d.simulator_user_id === accountId);
    };
    let provisioned = 0;
    (queue as any).provisionDevices = async (_run: any, _account: string, list: any[]) => {
        for (const device of list.filter(d => d.provisioning_state === 'planned')) {
            device.provisioning_state = 'provisioned';
            provisioned += 1;
        }
    };
    (queue as any).claimDevice = async (_run: any, _user: any, _account: string, device: any, token: string) => {
        device.provisioning_state = 'claimed';
        return token;
    };
    await queue.startRun(run);
    // Users are generated in parallel lanes; only the set of signed-in users matters.
    assert.deepEqual([...sessions].sort(), ['user0@example.test', 'user1@example.test', 'user2@example.test']);
    assert.equal(provisioned, 11);
    assert.equal(devices.length, 19);
    assert.ok(devices.every(device => device.provisioning_state === 'claimed'));
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
    assert.equal(sessions.length, 3);
});

test('a lost registration answer is recovered by signing in with the password only the Simulator holds', async (t) => {
    const { apiGateway } = await import('../src/infrastructure/api-gateway/client');
    const user: any = { run_id: 'run', generation_index: 0, email: 'Sim_0@example.test', full_name: 'Sim', credential: encrypt('random-password') };
    const writes: any[] = [];
    const db = { collection: () => ({ updateOne: async (_filter: any, change: any) => { writes.push(change.$set); } }) } as any;
    const pacer = { register: { take: async () => undefined }, login: { take: async () => undefined }, claim: async () => undefined } as any;
    let signIns = 0;
    const queue = new GenerationQueue(logger, () => db, 1, pacer, {
        accessToken: async () => 'unused',
        signIn: async () => { signIns += 1; return { accessToken: 'recovered', refreshToken: 'r', sessionId: 's' }; },
    } as any);
    (queue as any).safeEvent = async () => {};
    t.mock.method(apiGateway, 'register', async () => { throw Object.assign(new Error('exists'), { statusCode: 409, code: 'ACCOUNT_EXISTS' }); });
    t.mock.method(apiGateway, 'getCurrentUser', async () => ({ id: 'account-42', email: 'sim_0@example.test' }));
    const accountId = await (queue as any).registerAccount({ id: 'run' }, user, {});
    assert.equal(accountId, 'account-42');
    assert.equal(signIns, 1);
    assert.equal(writes[0].account_provenance, 'recovered_after_register');
    assert.equal(writes[0].account_created_by_simulator, true);

    // Someone else's account under the same e-mail: the password does not work.
    const stranger = new GenerationQueue(logger, () => db, 1, pacer, {
        accessToken: async () => 'unused',
        signIn: async () => { throw Object.assign(new Error('Invalid credentials'), { statusCode: 401 }); },
    } as any);
    await assert.rejects((stranger as any).registerAccount({ id: 'run' }, { ...user }, {}), /ACCOUNT_IDENTITY_COLLISION/);
});
