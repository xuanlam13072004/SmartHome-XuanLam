import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyLiveDeviceOwnership, verifyLiveOwnershipBatch } from '../src/provisioning/ownership';

/** Before a claimed device starts again, the factory API says whether it is still claimed. */

test('restart detects an unpair that occurred while the simulator was offline', async () => {
    const revoked: string[] = [];
    const manager = { revokeDeviceOwnership: async (mac: string) => { revoked.push(mac); } };
    const status = async (macs: string[]) => macs.map(mac => ({ mac, exists: true, claimed: false }));
    assert.equal(await verifyLiveDeviceOwnership({ mac: 'AA:00:00:00:00:01' }, manager, status), false);
    assert.deepEqual(revoked, ['AA:00:00:00:00:01']);
});

test('a restart with thousands of devices asks in batches of 500; retired devices are revoked too', async () => {
    const revoked: string[] = [];
    const asked: number[] = [];
    const manager = { revokeDeviceOwnership: async (mac: string) => { revoked.push(mac); } };
    const devices = Array.from({ length: 1200 }, (_, index) => ({ mac: `MAC-${index}` }));
    const owned = await verifyLiveOwnershipBatch(devices, manager, async (macs) => {
        asked.push(macs.length);
        return macs.map(mac => ({
            mac,
            exists: mac !== 'MAC-7',
            claimed: mac !== 'MAC-7' && mac !== 'MAC-900',
        }));
    });
    assert.deepEqual(asked, [500, 500, 200]);
    assert.equal(owned.size, 1198);
    assert.deepEqual(revoked, ['MAC-7', 'MAC-900']);
});

test('the API being unreachable never revokes ownership', async () => {
    let revoked = false;
    const manager = { revokeDeviceOwnership: async () => { revoked = true; } };
    await assert.rejects(verifyLiveDeviceOwnership({ mac: 'MAC' }, manager, async () => {
        throw new Error('API Gateway unavailable');
    }));
    assert.equal(revoked, false);
});
