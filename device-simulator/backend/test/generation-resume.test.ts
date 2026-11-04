import assert from 'node:assert/strict';
import test from 'node:test';
import { claimRunResume } from '../src/generation/resume';
import { withDeviceCounts } from '../src/api/user-device-counts';

test('partial run can resume once; running, cleaned and cleaning runs cannot', async () => {
    const run = { id: 'run', status: 'partial' };
    const runs = {
        findOneAndUpdate: async (filter: any, update: any) => {
            if (!filter.status.$in.includes(run.status)) return null;
            Object.assign(run, update.$set);
            return { ...run };
        },
        findOne: async () => run,
    } as any;
    const attempts = await Promise.allSettled([claimRunResume(runs, 'run'), claimRunResume(runs, 'run')]);
    assert.equal(attempts.filter(a => a.status === 'fulfilled').length, 1);
    assert.equal(run.status, 'queued');
    for (const status of ['running', 'cleaned', 'cleaning', 'cancelled']) {
        run.status = status;
        await assert.rejects(claimRunResume(runs, 'run'), { statusCode: 409 });
        assert.equal(run.status, status);
    }
});

test('user device counts are actual counts, including zero, not requested targets', async () => {
    const users = [3, 5, 3, 3, 2, 3].map((target, index) => ({
        account_id: `user${index}`, run_id: 'run', target_device_count: target,
    }));
    const db = { collection: () => ({ aggregate: () => ({ toArray: async () => [
        { _id: { run: 'run', user: 'user3' }, created: 3, claimed: 3 },
        { _id: { run: 'run', user: 'user4' }, created: 2, claimed: 1 },
        { _id: { run: 'run', user: 'user5' }, created: 3, claimed: 3 },
    ] }) }) } as any;
    const result = await withDeviceCounts(db, users);
    assert.deepEqual(result.map(u => u.created_device_count), [0, 0, 0, 3, 2, 3]);
    assert.equal(result[4].claimed_device_count, 1);
    assert.equal(result.reduce((sum, u) => sum + u.target_device_count, 0), 19);
    assert.deepEqual(await withDeviceCounts(db, []), []);
});
