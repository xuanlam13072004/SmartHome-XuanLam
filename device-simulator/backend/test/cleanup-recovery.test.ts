import assert from 'node:assert/strict';
import test from 'node:test';
import { CleanupCronjob } from '../src/cleanup/cronjob';
import { encrypt } from '../src/security/crypto';

/**
 * Cleanup goes through the system's official doors only: as each user it
 * unpairs the user's devices and deletes the account, then retires the
 * devices with the factory API (docs/architecture/load-testing.md).
 */

const logger = { child: () => logger, info() {}, warn() {}, error() {} } as any;
const matches = (row: any, filter: any) => Object.entries(filter).every(([key, value]: [string, any]) => (
    value && typeof value === 'object' && '$in' in value ? value.$in.includes(row[key]) : row[key] === value
));

const fixture = (options: { users?: number; devicesPerUser?: number; retention?: 'ttl' | 'permanent' } = {}) => {
    const run: any = { id: 'run', status: 'completed', config: { cleanup_policy: 'manual' }, cleanup_retries: 0 };
    let users: any[] = Array.from({ length: options.users ?? 1 }, (_, index) => ({
        run_id: 'run', generation_index: index, account_id: `account-${index}`, email: `user${index}@sim.test`,
        account_created_by_simulator: true, credential: encrypt(`password-${index}`),
        retention_policy: options.retention ?? 'ttl',
    }));
    let devices: any[] = users.flatMap(user => Array.from({ length: options.devicesPerUser ?? 2 }, (_, index) => ({
        run_id: 'run', simulator_user_id: user.account_id, mac: `${user.account_id}-MAC-${index}`,
        retention_policy: user.retention_policy,
    })));
    // What the system holds: accounts, the devices each owns, factory records.
    const accounts = new Set(users.map(user => user.account_id));
    const owned = new Map<string, string>(devices.map(device => [device.mac, device.simulator_user_id]));
    const factory = new Set(devices.map(device => device.mac));
    const calls: string[] = [];
    const failures = { unpair: 0, loginRefused: new Set<string>() };

    const registry = { collection: (name: string) => ({
        findOne: async (filter: any) => (name === 'simulation_runs' ? run : (name === 'simulated_users' ? users : devices).find(row => matches(row, filter)) ?? null),
        find: (filter: any) => ({ toArray: async () => name === 'simulation_runs'
            ? (filter.status === 'cleaning' && run.status === 'cleaning' ? [run] : [])
            : (name === 'simulated_users' ? users : devices).filter(row => matches(row, filter)) }),
        updateOne: async (filter: any, update: any) => {
            if (name === 'simulation_runs') {
                if (filter.status && filter.status !== run.status) return { matchedCount: 0 };
                Object.assign(run, update.$set || {});
                for (const key of Object.keys(update.$unset || {})) delete run[key];
                return { matchedCount: 1 };
            }
            const row = (name === 'simulated_users' ? users : devices).find(candidate => matches(candidate, filter));
            if (row) Object.assign(row, update.$set || {});
            return { matchedCount: row ? 1 : 0 };
        },
        deleteMany: async (filter: any) => { devices = devices.filter(row => !matches(row, filter)); },
        deleteOne: async (filter: any) => { users = users.filter(row => !matches(row, filter)); },
    }) };
    const accountOf = (token: string) => token.replace('token-', '');
    const dependencies: any = {
        registryDb: () => registry,
        generationQueue: () => ({ stopRun: async () => undefined }),
        runtimeManager: () => ({ removeDevice: async (mac: string) => { calls.push(`off ${mac}`); } }),
        accessToken: async (user: any) => {
            if (!accounts.has(user.account_id) || failures.loginRefused.has(user.account_id)) {
                throw Object.assign(new Error('Invalid credentials'), { statusCode: 401 });
            }
            calls.push(`login ${user.account_id}`);
            return `token-${user.account_id}`;
        },
        gateway: {
            listDevices: async (token: string) => [...owned].filter(([, owner]) => owner === accountOf(token))
                .map(([mac, owner]) => ({ mac, owner_id: owner, role: 'owner' })),
            unpairDevice: async (token: string, mac: string) => {
                if (failures.unpair > 0) {
                    failures.unpair -= 1;
                    throw Object.assign(new Error('socket hang up'), { statusCode: 0 });
                }
                calls.push(`unpair ${mac}`);
                if (owned.get(mac) !== accountOf(token)) throw Object.assign(new Error('Not found'), { statusCode: 404 });
                owned.delete(mac);
            },
            deleteAccount: async (token: string, password: string) => {
                const account = accountOf(token);
                assert.equal(password, `password-${account.split('-')[1]}`, 'the account is deleted with its own password');
                if ([...owned.values()].includes(account)) {
                    throw Object.assign(new Error('Remove devices first'), { statusCode: 409, code: 'ACCOUNT_OWNS_DEVICES' });
                }
                calls.push(`delete ${account}`);
                accounts.delete(account);
            },
            retireFactoryDevices: async (macs: string[]) => macs.map(mac => {
                if (owned.has(mac)) return { mac, status: 'claimed' };
                const existed = factory.delete(mac);
                calls.push(`retire ${mac}`);
                return { mac, status: existed ? 'retired' : 'missing' };
            }),
        },
        event: async () => undefined,
        mediaStore: undefined,
        concurrency: () => 4,
        sleep: async () => undefined,
    };
    return {
        run, dependencies, accounts, owned, factory, calls, failures,
        job: () => new CleanupCronjob(logger, dependencies),
        left: () => ({ users: users.length, devices: devices.length }),
    };
};

test('each user is cleaned through the public and factory APIs: unpair, delete the account, retire the devices', async () => {
    const f = fixture({ users: 3, devicesPerUser: 2 });
    const result = await f.job().cleanupRun('run');
    assert.equal(result.status, 'cleaned');
    assert.equal(result.accountsDeleted, 3);
    assert.equal(result.devicesDeleted, 6);
    assert.equal(f.run.status, 'cleaned');
    assert.deepEqual(f.left(), { users: 0, devices: 0 });
    assert.equal(f.accounts.size, 0);
    assert.equal(f.owned.size, 0);
    assert.equal(f.factory.size, 0);
    assert.deepEqual(f.run.cleanup_progress && {
        total: f.run.cleanup_progress.users_total, done: f.run.cleanup_progress.users_done, retired: f.run.cleanup_progress.devices_retired,
    }, { total: 3, done: 3, retired: 6 });
    // For each user: devices off first, then unpair before the account goes, retire last.
    const forUser = f.calls.filter(call => call.includes('account-0'));
    assert.deepEqual(forUser.map(call => call.split(' ')[0]), ['off', 'off', 'login', 'unpair', 'unpair', 'delete', 'retire', 'retire']);
});

test('the Console gets an answer at once; the cleanup carries on in the background', async () => {
    const f = fixture({ users: 2 });
    let release!: () => void;
    f.dependencies.generationQueue = () => ({ stopRun: () => new Promise<void>(resolve => { release = resolve; }) });
    const job = f.job();
    const answer = await job.startRunCleanup('run');
    assert.equal(answer.status, 'cleaning');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.run.status, 'cleaning');
    assert.equal((await job.startRunCleanup('run')).status, 'cleaning', 'a second press joins the first');
    release();
    assert.equal((await job.cleanupRun('run')).status, 'cleaned');
    assert.equal(f.run.status, 'cleaned');
});

test('a resumed cleanup does not sign in to an account it already deleted', async () => {
    const f = fixture({ users: 1, devicesPerUser: 1 });
    // The first attempt deleted the account, then the Simulator stopped before retiring the device.
    f.owned.clear();
    f.accounts.clear();
    const job = f.job();
    await f.dependencies.registryDb().collection('simulated_users').updateOne(
        { generation_index: 0 }, { $set: { account_deleted_at: new Date() } },
    );
    const result = await job.cleanupRun('run');
    assert.equal(result.status, 'cleaned');
    assert.ok(!f.calls.some(call => call.startsWith('login')));
    assert.deepEqual(f.calls.filter(call => call.startsWith('retire')), ['retire account-0-MAC-0']);
});

test('an account that cannot be signed in is forgotten only when it owns none of the devices', async () => {
    const gone = fixture({ users: 1, devicesPerUser: 1 });
    gone.accounts.clear(); // deleted by an earlier attempt whose answer was lost
    gone.owned.clear();
    assert.equal((await gone.job().cleanupRun('run')).status, 'cleaned');
    assert.deepEqual(gone.left(), { users: 0, devices: 0 });

    const changed = fixture({ users: 1, devicesPerUser: 1 });
    changed.failures.loginRefused.add('account-0'); // its password was changed in the app
    const result = await changed.job().cleanupRun('run');
    assert.equal(result.status, 'cleanup_blocked');
    assert.equal(changed.run.status, 'cleanup_blocked');
    assert.match(result.blocked?.[0].reason ?? '', /Không đăng nhập được/);
    assert.deepEqual(changed.left(), { users: 1, devices: 1 }, 'nothing is forgotten while the system still has it');
    assert.equal(changed.factory.size, 1);
});

test('a user that owns a device added with the app is blocked; the other users are cleaned', async () => {
    const f = fixture({ users: 3, devicesPerUser: 1 });
    f.owned.set('REAL-DEVICE', 'account-1');
    const result = await f.job().cleanupRun('run');
    assert.equal(result.status, 'cleanup_blocked');
    assert.equal(f.run.cleanup_progress.users_done, 2);
    assert.equal(f.run.cleanup_progress.users_blocked, 1);
    assert.equal(f.run.cleanup_progress.blocked[0].email, 'user1@sim.test');
    assert.match(f.run.cleanup_progress.blocked[0].reason, /không do Simulator tạo/);
    assert.ok(f.accounts.has('account-1'));
    assert.ok(!f.calls.includes('unpair REAL-DEVICE'), 'a device the Simulator did not make is never unpaired');
    assert.deepEqual(f.left(), { users: 1, devices: 1 }, 'the blocked user and its device are kept for the next attempt');

    // Once the owner removed it in the app, "Dọn dữ liệu" again finishes the job.
    f.owned.delete('REAL-DEVICE');
    assert.equal((await f.job().cleanupRun('run')).status, 'cleaned');
    assert.deepEqual(f.left(), { users: 0, devices: 0 });
});

test('a device now owned by another account is not retired and blocks its user', async () => {
    const f = fixture({ users: 1, devicesPerUser: 2 });
    f.owned.set('account-0-MAC-1', 'someone-else');
    const result = await f.job().cleanupRun('run');
    assert.equal(result.status, 'cleanup_blocked');
    assert.match(result.blocked?.[0].reason ?? '', /tài khoản khác/);
    assert.ok(f.factory.has('account-0-MAC-1'));
    assert.deepEqual(f.left(), { users: 1, devices: 2 });
});

test('errors are retried three times per user, then reported as failed without stopping the others', async () => {
    const transient = fixture({ users: 2, devicesPerUser: 1 });
    transient.failures.unpair = 2;
    assert.equal((await transient.job().cleanupRun('run')).status, 'cleaned');

    const persistent = fixture({ users: 2, devicesPerUser: 1 });
    persistent.failures.unpair = 3;
    persistent.dependencies.concurrency = () => 1;
    const result = await persistent.job().cleanupRun('run');
    assert.equal(result.status, 'cleanup_failed');
    assert.equal(persistent.run.status, 'cleanup_failed');
    assert.equal(persistent.run.cleanup_progress.users_failed, 1);
    assert.equal(persistent.run.cleanup_progress.users_done, 1);
    assert.match(persistent.run.last_cleanup_error, /thử lại/);
});

test('"Dọn dữ liệu" also removes users kept with "Giữ dữ liệu"; the scheduled sweep leaves them', async () => {
    const asked = fixture({ users: 1, retention: 'permanent' });
    assert.equal((await asked.job().cleanupRun('run')).status, 'cleaned');
    assert.deepEqual(asked.left(), { users: 0, devices: 0 });

    const scheduled = fixture({ users: 1, retention: 'permanent' });
    const kept = await scheduled.job().cleanupRun('run', 'completed');
    assert.equal(kept.retainedUsers, 1);
    assert.equal(scheduled.run.status, 'completed');
    assert.ok(!scheduled.calls.some(call => call.startsWith('unpair')));
});

test('an expired-run snapshot cannot clean a run that has since resumed; a restart resumes a cleaning run', async () => {
    const f = fixture();
    f.run.status = 'queued';
    await assert.rejects(f.job().cleanupRun('run', 'partial'), { statusCode: 409 });
    assert.equal(f.run.status, 'queued');
    assert.equal(f.calls.length, 0);

    f.run.status = 'cleaning';
    f.run.cleanup_includes_kept = true;
    const job = f.job();
    await job.recoverInterruptedCleanups();
    assert.equal((await job.cleanupRun('run', 'cleaning')).status, 'cleaned', 'joins the resumed cleanup');
    assert.equal(f.run.status, 'cleaned');
});
