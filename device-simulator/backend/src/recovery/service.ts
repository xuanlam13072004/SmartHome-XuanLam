import type { FastifyBaseLogger } from 'fastify';
import type { SimulationRun } from '../domain/simulation-run';
import type { SimulatedDeviceRecord } from '../domain/registry';
import { getMongoDb } from '../infrastructure/mongodb/client';
import { getGenerationQueue } from '../generation/queue';
import { getRuntimeManager } from '../runtime/manager';
import { recordSimulatorEvent } from '../events/service';
import { shouldRestoreRunRuntime } from '../runtime/recovery-policy';
import { assignmentFromClaim } from '../runtime/topology';
import { resolveDeviceProduct } from '../catalog/device-contract';

export class RecoveryService {
    private readonly logger: FastifyBaseLogger;

    constructor(logger: FastifyBaseLogger) {
        this.logger = logger.child({ module: 'RecoveryService' });
    }

    async recover(): Promise<void> {
        const db = getMongoDb();
        const queue = getGenerationQueue(this.logger);

        const recoverableRuns = await db.collection<SimulationRun>('simulation_runs')
            .find({ status: { $in: ['queued', 'running'] } })
            .toArray();
        for (const run of recoverableRuns) {
            void queue.startRun(run).catch((error) => {
                this.logger.error({ err: error, runId: run.id }, 'Failed to resume simulation run');
            });
        }

        const pausedRuns = await db.collection<SimulationRun>('simulation_runs')
            .find({ status: 'paused' })
            .project<{ id: string }>({ id: 1 })
            .toArray();
        const pausedRunIds = pausedRuns.map((run) => run.id);
        if (pausedRunIds.length > 0) {
            await db.collection<SimulatedDeviceRecord>('simulated_devices').updateMany(
                {
                    run_id: { $in: pausedRunIds },
                    provisioning_state: 'claimed',
                    desired_state: 'online',
                },
                { $set: { runtime_state: 'paused', updated_at: new Date() } },
            );
        }

        const onlineDevices = await db.collection<SimulatedDeviceRecord>('simulated_devices')
            .find({
                provisioning_state: 'claimed',
                desired_state: 'online',
            })
            .toArray();
        const runIds = [...new Set(onlineDevices.map((device) => device.run_id))];
        const runs = await db.collection<SimulationRun>('simulation_runs')
            .find({ id: { $in: runIds } })
            .toArray();
        const runMap = new Map(runs.map((run) => [run.id, run]));
        const manager = getRuntimeManager(this.logger);

        let recoveredDevices = 0;
        for (const device of onlineDevices) {
            const run = runMap.get(device.run_id);
            if (!run || !shouldRestoreRunRuntime(run.status)) {
                continue;
            }
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
                recoveredDevices += 1;
            } catch (error) {
                this.logger.warn({ err: error, mac: device.mac }, 'Failed to recover virtual device runtime');
            }
        }

        await recordSimulatorEvent({
            type: 'system.recovered',
            severity: 'info',
            message: 'Simulator restart recovery completed',
            data: {
                resumed_runs: recoverableRuns.length,
                recovered_devices: recoveredDevices,
                paused_runs_preserved: pausedRunIds.length,
            },
        }).catch(() => undefined);
        this.logger.info({
            resumedRuns: recoverableRuns.length,
            recoveredDevices,
            pausedRunsPreserved: pausedRunIds.length,
        }, 'Simulator restart recovery completed');
    }
}
