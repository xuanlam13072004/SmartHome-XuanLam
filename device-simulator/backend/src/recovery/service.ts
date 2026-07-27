import type { FastifyBaseLogger } from 'fastify';
import type { SimulationRun } from '../domain/simulation-run';
import type { SimulatedDeviceRecord } from '../domain/registry';
import { getMongoDb } from '../infrastructure/mongodb/client';
import { getGenerationQueue } from '../generation/queue';
import { getRuntimeManager } from '../runtime/manager';
import { recordSimulatorEvent } from '../events/service';

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
            if (!run || ['cleaning', 'cleaned', 'cleanup_blocked'].includes(run.status)) continue;
            const runtime = manager.addDevice(
                device.mac,
                device.product_id,
                run.config.telemetry_interval * 1000,
                device.seq || 0,
                device.state_snapshot,
            );
            try {
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
            },
        }).catch(() => undefined);
        this.logger.info({
            resumedRuns: recoverableRuns.length,
            recoveredDevices,
        }, 'Simulator restart recovery completed');
    }
}
