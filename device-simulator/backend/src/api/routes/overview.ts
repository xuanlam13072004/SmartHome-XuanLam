import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';
import type { SimulatedDeviceRecord, SimulatedUserRecord } from '../../domain/registry';
import type { SimulationRun } from '../../domain/simulation-run';
import { getMongoDb } from '../../infrastructure/mongodb/client';
import { getConnectScheduler } from '../../runtime/connect-scheduler';
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

    app.get('/api/overview', async (_request, reply) => {
        const scheduler = getTelemetryScheduler().getStats();
        const registry = await registryCounts();
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
            // Connections waiting, opening or retrying (runtime/connect-scheduler.ts).
            connects: getConnectScheduler(app.log).stats(),
            rates: getRunMetricsService(app.log).globalRates(),
            registry,
            limits: {
                mqtt_connects_per_second: env.MQTT_CONNECTS_PER_SECOND,
                mqtt_connect_concurrency: env.MQTT_CONNECT_CONCURRENCY,
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
