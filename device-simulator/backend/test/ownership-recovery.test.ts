import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyLiveDeviceOwnership } from '../src/provisioning/ownership';

test('restart detects an unpair that occurred while simulator was offline', async () => {
    const revoked: string[] = [];
    const device = { mac: 'AA:00:00:00:00:01', simulator_user_id: 'original-owner' } as any;
    const manager = { revokeDeviceOwnership: async (mac: string) => { revoked.push(mac); } };
    const pool = () => ({ query: async (_sql: string, params: unknown[]) => {
        assert.deepEqual(params, [device.mac, 'original-owner']);
        return { rows: [] };
    } }) as any;
    assert.equal(await verifyLiveDeviceOwnership(device, manager, pool), false);
    assert.deepEqual(revoked, [device.mac]);
});

test('the current owner restores normally and a database failure never revokes ownership', async () => {
    let revoked = false;
    const manager = { revokeDeviceOwnership: async () => { revoked = true; } };
    const device = { mac: 'MAC', simulator_user_id: 'owner' } as any;
    assert.equal(await verifyLiveDeviceOwnership(device, manager,
        (() => ({ query: async () => ({ rows: [{ id: 'device-id' }] }) })) as any), true);
    await assert.rejects(verifyLiveDeviceOwnership(device, manager,
        (() => ({ query: async () => { throw new Error('PostgreSQL unavailable'); } })) as any));
    assert.equal(revoked, false);
});
