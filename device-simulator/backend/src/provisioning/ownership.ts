import type { SimulatedDeviceRecord } from '../domain/registry';
import { apiGateway } from '../infrastructure/api-gateway/client';
import type { RequestOptions } from '../infrastructure/api-gateway/rate-limit-retry';
import type { RuntimeManager } from '../runtime/manager';

/**
 * Before a claimed device is started again (restart, resume, "Bật lại thiết
 * bị"), the Simulator asks the factory API whether it is still claimed: a
 * device unpaired while the Simulator was down would otherwise never learn it
 * (its retained tombstone may be gone). Only the Simulator knows the claim
 * secret of a run device, so "claimed" means its simulated user still owns
 * it; a factory device belongs to whoever claimed it, which is fine as well.
 *
 * One call per 500 devices: a restart with 30 000 devices costs 60 requests.
 * Devices no longer claimed (or no longer known) are revoked, not started.
 */

const STATUS_BATCH = 500;

export type OwnershipStatus = (macs: string[], options?: RequestOptions) =>
    Promise<Array<{ mac: string; exists: boolean; claimed: boolean }>>;

export async function verifyLiveOwnershipBatch(
    devices: Array<Pick<SimulatedDeviceRecord, 'mac'>>,
    manager: Pick<RuntimeManager, 'revokeDeviceOwnership'>,
    status: OwnershipStatus = (macs, options) => apiGateway.factoryDeviceStatus(macs, options),
    options: RequestOptions = {},
): Promise<Set<string>> {
    const owned = new Set<string>();
    for (let index = 0; index < devices.length; index += STATUS_BATCH) {
        const chunk = devices.slice(index, index + STATUS_BATCH);
        const claimed = new Set((await status(chunk.map(device => device.mac), options))
            .filter(row => row.claimed)
            .map(row => row.mac));
        for (const device of chunk) {
            if (claimed.has(device.mac)) owned.add(device.mac);
            else await manager.revokeDeviceOwnership(device.mac);
        }
    }
    return owned;
}

/** The same check for one device. */
export async function verifyLiveDeviceOwnership(
    device: Pick<SimulatedDeviceRecord, 'mac'>,
    manager: Pick<RuntimeManager, 'revokeDeviceOwnership'>,
    status?: OwnershipStatus,
): Promise<boolean> {
    return (await verifyLiveOwnershipBatch([device], manager, status)).has(device.mac);
}
