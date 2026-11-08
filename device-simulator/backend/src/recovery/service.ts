import type { FastifyBaseLogger } from 'fastify';
import type { SimulationRun } from '../domain/simulation-run';
import type { SimulatedDeviceRecord } from '../domain/registry';
import { getMongoDb } from '../infrastructure/mongodb/client';
import { getGenerationQueue } from '../generation/queue';
import { recordSimulatorEvent } from '../events/service';
import { restoreDeviceRuntimes } from '../runtime/restore-run';

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
        // Batched ownership check and parallel restore (runtime/restore-run.ts).
        const { recovered: recoveredDevices } = await restoreDeviceRuntimes(runs, onlineDevices, this.logger);

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
