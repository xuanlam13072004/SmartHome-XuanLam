import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';
import type { SimulatedDeviceRecord, SimulatedUserRecord } from '../../domain/registry';
import type { SimulationRun } from '../../domain/simulation-run';
import { getMainMongoDb, getMongoDb } from '../../infrastructure/mongodb/client';
import { processSampler } from '../../metrics/process-stats';
import { getRunMetricsService } from '../../metrics/service';
import { getRegistryWriter } from '../../runtime/registry-writer';
import { getRuntimeManager } from '../../runtime/manager';
import { getTelemetryScheduler } from '../../runtime/telemetry-scheduler';

/** Small TTL cache: several open dashboards share one database query. */
const cached = <T>(ttlMs: number, load: () => Promise<T>) => {
    let value: { at: number; data: Promise<T> } | null = null;
    return (): Promise<T> => {
        if (!value || Date.now() - value.at > ttlMs) {
            const data = load();
            value = { at: Date.now(), data };
            data.catch(() => { value = null; });
        }
        return value.data;
    };
};

export interface IngestLatency {
    samples: number;
    p50_ms: number;
    p95_ms: number;
    max_ms: number;
}

const percentile = (sorted: number[], fraction: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];

/** How long telemetry takes from the device clock to the backend database (last 30 s). */
export const measureIngestLatency = (rows: Array<{ observed_at?: Date; ingested_at?: Date }>): IngestLatency | null => {
    const values = rows
        .filter((row) => row.observed_at && row.ingested_at)
        .map((row) => Math.max(0, new Date(row.ingested_at as Date).getTime() - new Date(row.observed_at as Date).getTime()))
        .sort((left, right) => left - right);
    if (values.length === 0) return null;
    return {
        samples: values.length,
        p50_ms: percentile(values, 0.5),
        p95_ms: percentile(values, 0.95),
        max_ms: values[values.length - 1],
    };
};

const overviewRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
    const manager = getRuntimeManager(app.log);
    processSampler.start();
    app.addHook('onClose', async () => processSampler.stop());

    const registryCounts = cached(3000, async () => {
        const db = getMongoDb();
        const [states, users, activeRuns] = await Promise.all([
            db.collection<SimulatedDeviceRecord>('simulated_devices').aggregate<{ _id: string; count: number }>([
                { $group: { _id: '$runtime_state', count: { $sum: 1 } } },
            ]).toArray(),
            db.collection<SimulatedUserRecord>('simulated_users').estimatedDocumentCount(),
            db.collection<SimulationRun>('simulation_runs').countDocuments({ status: { $in: ['queued', 'running', 'paused'] } }),
        ]);
        const byState = Object.fromEntries(states.map((row) => [row._id || 'unknown', row.count]));
        const total = states.reduce((sum, row) => sum + row.count, 0);
        return { devices_total: total, devices_by_state: byState, users_total: users, active_runs: activeRuns };
    });

    const ingest = cached(5000, async () => {
        const rows = await getMainMongoDb().collection(env.MAIN_MONGO_TELEMETRY_COLLECTION)
            .find(
                { observed_at: { $gte: new Date(Date.now() - 30_000) } },
                { projection: { _id: 0, observed_at: 1, ingested_at: 1 } },
            )
            .limit(5000)
            .toArray();
        return measureIngestLatency(rows as Array<{ observed_at?: Date; ingested_at?: Date }>);
    });

    app.get('/api/overview', async (_request, reply) => {
        const scheduler = getTelemetryScheduler().getStats();
        const [registry, latency] = await Promise.all([
            registryCounts(),
            ingest().catch(() => null),
        ]);
        reply.header('Cache-Control', 'no-store');
        return {
            success: true,
            sampled_at: new Date().toISOString(),
            process: processSampler.stats(),
            runtime: {
                ...manager.getGlobalStats(),
                scheduler_due: scheduler.due,
                registry_pending_writes: getRegistryWriter().pendingCount,
            },
            rates: getRunMetricsService(app.log).globalRates(),
            registry,
            ingest_latency: latency,
            limits: {
                gateway_register_per_minute: env.GATEWAY_REGISTER_PER_MINUTE,
                gateway_login_per_minute: env.GATEWAY_LOGIN_PER_MINUTE,
                gateway_claim_per_account_per_minute: env.GATEWAY_CLAIM_PER_ACCOUNT_PER_MINUTE,
                generation_concurrency: env.GENERATION_CONCURRENCY,
                max_users_per_run: env.MAX_USERS_PER_RUN,
                max_devices_per_run: env.MAX_DEVICES_PER_RUN,
                max_active_devices: env.MAX_ACTIVE_DEVICES,
                max_telemetry_messages_per_second: env.MAX_TELEMETRY_MESSAGES_PER_SECOND,
            },
        };
    });
};

export default overviewRoutes;
