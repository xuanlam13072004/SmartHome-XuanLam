import type { Collection } from 'mongodb';
import type { SimulationRun } from '../domain/simulation-run';

/** Compare-and-set makes two clicks (or cleanup racing resume) unable to revive stale state. */
export async function claimRunResume(runs: Collection<SimulationRun>, id: string): Promise<SimulationRun> {
    const run = await runs.findOneAndUpdate(
        { id, status: { $in: ['paused', 'failed', 'partial'] } },
        { $set: { status: 'queued', updated_at: new Date() } },
        { returnDocument: 'after' },
    );
    if (run) return run;
    const exists = await runs.findOne({ id }, { projection: { id: 1 } });
    throw Object.assign(new Error(exists
        ? 'Only paused, failed or partial runs can resume'
        : 'Simulation run not found'), { statusCode: exists ? 409 : 404 });
}
