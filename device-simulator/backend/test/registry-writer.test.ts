import assert from 'node:assert/strict';
import test from 'node:test';
import { RegistryWriter } from '../src/runtime/registry-writer';

const fakeDb = (options: { failBulk?: boolean } = {}) => {
    const bulks: any[][] = [];
    const updates: any[] = [];
    const db = {
        collection: () => ({
            bulkWrite: async (operations: any[]) => {
                if (options.failBulk) throw new Error('mongo down');
                bulks.push(operations);
            },
            updateOne: async (filter: any, update: any) => { updates.push([filter, update]); },
        }),
    };
    return { db: db as any, bulks, updates };
};

test('telemetry state is merged per device and written in one unordered batch', async () => {
    const { db, bulks, updates } = fakeDb();
    const writer = new RegistryWriter(() => db, 60_000);
    for (let index = 0; index < 3; index += 1) {
        writer.defer('AA:00:00:00:00:01', { runtime_state: 'online', last_telemetry: new Date(index) });
    }
    writer.defer('AA:00:00:00:00:02', { runtime_state: 'paused' });
    assert.equal(writer.pendingCount, 2);
    await writer.flush();
    assert.equal(updates.length, 0);
    assert.equal(bulks.length, 1);
    assert.equal(bulks[0].length, 2);
    const first = bulks[0].find((op) => op.updateOne.filter.mac === 'AA:00:00:00:00:01');
    assert.deepEqual(first.updateOne.update.$set.last_telemetry, new Date(2));
    assert.equal(writer.pendingCount, 0);
    await writer.stop();
});

test('a manual write carries pending fields so a later batch cannot overwrite it', async () => {
    const { db, bulks, updates } = fakeDb();
    const writer = new RegistryWriter(() => db, 60_000);
    writer.defer('AA:00:00:00:00:01', { runtime_state: 'online', last_telemetry: new Date(1) });
    await writer.writeNow('AA:00:00:00:00:01', { state_snapshot: { state_version: 9 } as any, transport_mode: undefined });
    assert.equal(updates.length, 1);
    assert.deepEqual(Object.keys(updates[0][1].$set).sort(), ['last_telemetry', 'runtime_state', 'state_snapshot']);
    await writer.flush();
    assert.equal(bulks.length, 0);
    await writer.stop();
});

test('a failed batch is kept for the next flush without replacing newer fields', async () => {
    const state = { failBulk: true };
    const { db, bulks } = fakeDb(state);
    const writer = new RegistryWriter(() => db, 60_000);
    writer.defer('AA:00:00:00:00:01', { runtime_state: 'online' });
    writer.defer('AA:00:00:00:00:02', { runtime_state: 'online' });
    const failed = writer.flush();
    writer.defer('AA:00:00:00:00:02', { runtime_state: 'paused' });
    await assert.rejects(failed, /mongo down/);
    state.failBulk = false;
    await writer.flush();
    const byMac = Object.fromEntries(bulks[0].map((op) => [op.updateOne.filter.mac, op.updateOne.update.$set.runtime_state]));
    assert.deepEqual(byMac, { 'AA:00:00:00:00:01': 'online', 'AA:00:00:00:00:02': 'paused' });
    await writer.stop();
});
