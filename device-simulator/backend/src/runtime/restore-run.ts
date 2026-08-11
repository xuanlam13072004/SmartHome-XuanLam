import type { FastifyBaseLogger } from 'fastify';
import type { SimulatedDeviceRecord } from '../domain/registry';
import type { SimulationRun } from '../domain/simulation-run';
import { getMongoDb } from '../infrastructure/mongodb/client';
import { getRuntimeManager } from './manager';
import { shouldRestoreRunRuntime } from './recovery-policy';
import { assignmentFromClaim } from './topology';
import { resolveDeviceProduct } from '../catalog/device-contract';

export const restoreRunDevices = async (
    run: SimulationRun,
    logger: FastifyBaseLogger,
): Promise<{ recovered: number; failed: number }> => {
    if (!shouldRestoreRunRuntime(run.status)) return { recovered: 0, failed: 0 };

    const devices = await getMongoDb().collection<SimulatedDeviceRecord>('simulated_devices')
        .find({
            run_id: run.id,
            provisioning_state: 'claimed',
            desired_state: 'online',
        })
        .toArray();
    const manager = getRuntimeManager(logger);
    let recovered = 0;
    let failed = 0;

    for (const device of devices) {
        try {
            const product = await resolveDeviceProduct(device);
            const runtime = manager.addDevice(
                run.id,
                device.mac,
                product,
                run.config.telemetry_interval * 1000,
                run.config.telemetry_jitter_percent ?? 10,
                run.config.startup_ramp_seconds ?? 30,
                device.seq || 0,
                device.state_snapshot,
                assignmentFromClaim(device),
            );
            await runtime.connect();
            await runtime.resume();
            recovered += 1;
        } catch (error) {
            failed += 1;
            logger.warn(
                { err: error, runId: run.id, mac: device.mac },
                'Failed to restore virtual device runtime',
            );
        }
    }

    return { recovered, failed };
};
