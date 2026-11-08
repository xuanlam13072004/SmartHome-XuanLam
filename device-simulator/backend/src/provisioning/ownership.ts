import type { SimulatedDeviceRecord } from '../domain/registry';
import { getPgPool } from '../infrastructure/postgres/client';
import type { RuntimeManager } from '../runtime/manager';

/** Retained MQTT tombstones disappear; confirm ownership also after an offline restart. */
export async function verifyLiveDeviceOwnership(
    device: SimulatedDeviceRecord,
    manager: Pick<RuntimeManager, 'revokeDeviceOwnership'>,
    pgPool = getPgPool,
): Promise<boolean> {
    const result = await pgPool().query(
        'SELECT id FROM device_metadata WHERE mac = $1 AND owner_id = $2 AND is_active = true',
        [device.mac, device.simulator_user_id],
    );
    if (result.rows.length > 0) return true;
    await manager.revokeDeviceOwnership(device.mac);
    return false;
}

/**
 * Batched form of `verifyLiveDeviceOwnership` for restarts: one query per
 * 5 000 devices instead of one per device. Returns the MACs still owned by
 * their simulated account; the others are revoked.
 */
export async function verifyLiveOwnershipBatch(
    devices: Array<Pick<SimulatedDeviceRecord, 'mac' | 'simulator_user_id'>>,
    manager: Pick<RuntimeManager, 'revokeDeviceOwnership'>,
    pgPool = getPgPool,
): Promise<Set<string>> {
    const owned = new Set<string>();
    for (let index = 0; index < devices.length; index += 5000) {
        const chunk = devices.slice(index, index + 5000);
        const result = await pgPool().query<{ mac: string; owner_id: string }>(
            'SELECT mac, owner_id::text FROM device_metadata WHERE mac = ANY($1::text[]) AND is_active = true',
            [chunk.map((device) => device.mac)],
        );
        const owners = new Map(result.rows.map((row) => [row.mac, row.owner_id]));
        for (const device of chunk) {
            if (owners.get(device.mac) === device.simulator_user_id) owned.add(device.mac);
            else await manager.revokeDeviceOwnership(device.mac);
        }
    }
    return owned;
}
