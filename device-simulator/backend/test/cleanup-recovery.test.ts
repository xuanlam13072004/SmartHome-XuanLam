import assert from 'node:assert/strict';
import test from 'node:test';
import { CleanupCronjob } from '../src/cleanup/cronjob';

const logger = { child: () => logger, info() {}, warn() {}, error() {} } as any;
const fixture = () => {
    const run: any = { id: 'run', status: 'cleaning', config: { cleanup_policy: 'manual' } };
    let users: any[] = [{ run_id: 'run', account_id: 'account', account_created_by_simulator: true, retention_policy: 'ttl' }];
    let devices: any[] = [{ run_id: 'run', simulator_user_id: 'account', mac: 'MAC', factory_owned: true, retention_policy: 'ttl' }];
    let accountExists = true;
    let failMain = false;
    let unpairs = 0;
    let authCalls = 0;
    let mainDeletes = 0;
    let brokerRevocations = 0;
    const registry = { collection: (name: string) => ({
        findOne: async () => run,
        find: (filter: any) => ({ toArray: async () => name === 'simulation_runs'
            ? (filter.status === 'cleaning' && run.status === 'cleaning' ? [run] : [])
            : name === 'simulated_users' ? users : devices }),
        updateOne: async (_filter: any, update: any) => {
            if (name !== 'simulation_runs') return;
            Object.assign(run, update.$set || {});
            for (const key of Object.keys(update.$unset || {})) delete run[key];
            if (update.$addToSet?.cleanup_unpaired_macs) {
                run.cleanup_unpaired_macs = [...new Set([...(run.cleanup_unpaired_macs || []), update.$addToSet.cleanup_unpaired_macs])];
            }
        },
        deleteMany: async () => { if (name === 'simulated_users') users = []; else devices = []; },
    }) };
    const pg = {
        query: async (sql: string) => ({ rows: sql.startsWith('SELECT id::text FROM accounts') && accountExists ? [{ id: 'account' }] : [] }),
        connect: async () => ({
            query: async (sql: string) => { if (sql === 'COMMIT') accountExists = false; }, release() {},
        }),
    };
    const dependencies: any = {
        registryDb: () => registry, pgPool: () => pg,
        mainDb: () => ({ collection: () => ({ deleteMany: async () => {
            mainDeletes++;
            if (failMain) throw new Error('Mongo temporarily unavailable');
        } }) }),
        generationQueue: () => ({ stopRun: async () => undefined }),
        runtimeManager: () => ({
            removeDevice: async () => undefined,
            revokeBrokerIdentity: async () => { brokerRevocations++; },
        }),
        gateway: { unpairDevice: async () => { unpairs++; } },
        event: async () => undefined,
    };
    const create = () => {
        const job = new CleanupCronjob(logger, dependencies);
        (job as any).getCleanupAccessToken = async () => { authCalls++; return 'test-token'; };
        return job;
    };
    return { run, dependencies, create, failMain: () => { failMain = true; }, restoreMain: () => { failMain = false; },
        stats: () => ({ unpairs, authCalls, accountExists, mainDeletes, brokerRevocations, users: users.length, devices: devices.length }) };
};

test('restart continues interrupted manual cleanup after PostgreSQL deletion without authenticating a deleted account', async () => {
    const f = fixture();
    f.failMain();
    await assert.rejects(f.create().cleanupRun('run'), /Mongo temporarily/);
    assert.equal(f.stats().accountExists, false);
    assert.deepEqual(f.run.cleanup_unpaired_macs, ['MAC']);
    // A hard restart can leave the durable run in cleaning instead of entering the catch handler.
    f.run.status = 'cleaning';
    f.restoreMain();
    await f.create().recoverInterruptedCleanups();
    assert.equal(f.run.status, 'cleaned');
    assert.equal(f.stats().authCalls, 1);
    assert.equal(f.stats().unpairs, 1);
    assert.equal(f.stats().users, 0);
    assert.equal(f.stats().devices, 0);
    // The factory-owned device's broker identity was retired (idempotently, once per attempt).
    assert.ok(f.stats().brokerRevocations >= 1);
});

test('an expired-run snapshot cannot clean a run that has since resumed', async () => {
    const f = fixture();
    f.run.status = 'queued';
    await assert.rejects(f.create().cleanupRun('run', 'partial'), { statusCode: 409 });
    assert.equal(f.run.status, 'queued');
    assert.equal(f.stats().mainDeletes, 0);
    assert.equal(f.stats().authCalls, 0);
});

test('cleanup waits for generation before reading its user/device snapshot and coalesces duplicate requests', async () => {
    const f = fixture();
    let release!: () => void;
    f.dependencies.generationQueue = () => ({ stopRun: async () => new Promise<void>(resolve => { release = resolve; }) });
    const job = f.create();
    const first = job.cleanupRun('run');
    await new Promise(resolve => setImmediate(resolve));
    const duplicate = job.cleanupRun('run');
    assert.equal(f.stats().unpairs, 0);
    release();
    await Promise.all([first, duplicate]);
    assert.equal(f.stats().unpairs, 1);
    assert.equal(f.run.status, 'cleaned');
});

test('cleanup blocks deletion of a tracked device transferred to another owner', async () => {
    const f = fixture();
    f.dependencies.pgPool = () => ({ query: async (sql: string) => ({
        rows: sql.includes('SELECT owner_id::text, mac') ? [{ owner_id: 'another-owner', mac: 'MAC' }] : [],
    }) });
    const result = await f.create().cleanupRun('run');
    assert.equal(result.status, 'cleanup_blocked');
    assert.equal(f.stats().unpairs, 0);
    assert.equal(f.stats().mainDeletes, 0);
    assert.equal(f.stats().brokerRevocations, 0);
    assert.equal(f.stats().devices, 1);
});
