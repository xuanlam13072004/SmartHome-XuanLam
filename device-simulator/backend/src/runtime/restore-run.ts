import type { FastifyBaseLogger } from 'fastify';
import type { SimulatedDeviceRecord } from '../domain/registry';
import type { SimulationRun } from '../domain/simulation-run';
import { getMongoDb } from '../infrastructure/mongodb/client';
import { getRuntimeManager } from './manager';
import { shouldRestoreRunRuntime } from './recovery-policy';
import { assignmentFromClaim } from './topology';
import { resolveDeviceProduct } from '../catalog/device-contract';
import { ensureAccessPin } from '../security/device-pin';
import { verifyLiveOwnershipBatch } from '../provisioning/ownership';

/** Runtimes built at the same time (registry reads); their MQTT connections go through the connect scheduler. */
const RESTORE_CONCURRENCY = 64;

export const runWithConcurrency = async <T>(
    items: T[],
    limit: number,
    worker: (item: T) => Promise<void>,
): Promise<void> => {
    let next = 0;
    const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const item = items[next];
            next += 1;
            await worker(item);
        }
    });
    await Promise.all(lanes);
};

/**
 * Starts the runtimes of claimed, switched-on devices of the given runs.
 * Ownership is checked in batches (factory API); devices unpaired while the
 * simulator was down are revoked instead of started. Connections are queued
 * with the connect scheduler, so a restart with 30 000 devices reaches the
 * broker at MQTT_CONNECTS_PER_SECOND instead of all at once; `recovered`
 * counts the devices queued, the overview shows how many are connected.
 */
export const restoreDeviceRuntimes = async (
    runs: SimulationRun[],
    devices: SimulatedDeviceRecord[],
    logger: FastifyBaseLogger,
    options: { resume?: boolean } = {},
): Promise<{ recovered: number; failed: number }> => {
    const runMap = new Map(runs.filter((run) => shouldRestoreRunRuntime(run.status)).map((run) => [run.id, run]));
    const candidates = devices.filter((device) => runMap.has(device.run_id));
    if (candidates.length === 0) return { recovered: 0, failed: 0 };
    const manager = getRuntimeManager(logger);
    const owned = await verifyLiveOwnershipBatch(candidates, manager);
    let recovered = 0;
    let failed = 0;
    await runWithConcurrency(candidates.filter((device) => owned.has(device.mac)), RESTORE_CONCURRENCY, async (device) => {
        const run = runMap.get(device.run_id) as SimulationRun;
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
                await ensureAccessPin(device),
                device.irrigation_session,
            );
            // A runtime that already exists (paused run resumed) continues at once;
            // a new one is connected by the scheduler.
            if (options.resume && runtime.paused) await runtime.resume();
            else manager.scheduleConnect(runtime);
            recovered += 1;
        } catch (error) {
            failed += 1;
            logger.warn({ err: error, runId: run.id, mac: device.mac }, 'Failed to restore virtual device runtime');
        }
    });
    return { recovered, failed };
};

export const restoreRunDevices = async (
    run: SimulationRun,
    logger: FastifyBaseLogger,
): Promise<{ recovered: number; failed: number }> => {
    if (!shouldRestoreRunRuntime(run.status)) return { recovered: 0, failed: 0 };
    const devices = await getMongoDb().collection<SimulatedDeviceRecord>('simulated_devices')
        .find({ run_id: run.id, provisioning_state: 'claimed', desired_state: 'online' })
        .toArray();
    return restoreDeviceRuntimes([run], devices, logger, { resume: true });
};
