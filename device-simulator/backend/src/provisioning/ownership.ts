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
