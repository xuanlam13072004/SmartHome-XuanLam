import type { FastifyBaseLogger } from 'fastify';
import { env } from '../config/env';
import type {
    SimulationRun,
    SimulationRunMetricTotals,
} from '../domain/simulation-run';
import { getMongoDb } from '../infrastructure/mongodb/client';

export type RunMetricName = keyof SimulationRunMetricTotals;
export type RunMetricIncrement = Partial<Record<RunMetricName, number>>;

interface RateBucket {
    second: number;
    counters: RunMetricIncrement;
}

export interface RuntimeMetricStats {
    registered: number;
    connected: number;
    broker_connected: number;
    relay_connected: number;
    direct_fallback_connected: number;
    paused: number;
    scheduler_active: number;
    scheduler_due: number;
}

export interface RunMetricsSnapshot {
    run_id: string;
    sampled_at: string;
    totals: SimulationRunMetricTotals;
    rates: {
        window_seconds: number;
        telemetry_per_second: number;
        telemetry_failures_per_minute: number;
        bytes_per_second: number;
        operations_per_second: number;
    };
    runtime: RuntimeMetricStats;
    process: {
        rss_bytes: number;
        heap_used_bytes: number;
        uptime_seconds: number;
    };
    last_activity_at?: string;
}

export const emptyMetricTotals = (): SimulationRunMetricTotals => ({
    telemetry_published: 0,
    telemetry_failed: 0,
    telemetry_bytes: 0,
    operations_received: 0,
    operations_applied: 0,
    operations_rejected: 0,
    acks_published: 0,
    acks_failed: 0,
    mqtt_connects: 0,
    mqtt_disconnects: 0,
    mqtt_errors: 0,
});

const addCounters = (
    target: RunMetricIncrement,
    increments: RunMetricIncrement,
): void => {
    for (const [name, value] of Object.entries(increments) as [RunMetricName, number][]) {
        if (!Number.isFinite(value) || value === 0) continue;
        target[name] = (target[name] || 0) + value;
    }
};

export const calculateWindowRates = (
    buckets: RateBucket[],
    nowSecond: number,
    maximumWindowSeconds: number,
): RunMetricsSnapshot['rates'] => {
    const activeBuckets = buckets.filter(
        (bucket) => bucket.second > nowSecond - maximumWindowSeconds,
    );
    const aggregate: RunMetricIncrement = {};
    for (const bucket of activeBuckets) addCounters(aggregate, bucket.counters);

    const oldestSecond = activeBuckets[0]?.second ?? nowSecond;
    const observedSeconds = Math.max(
        1,
        Math.min(maximumWindowSeconds, nowSecond - oldestSecond + 1),
    );
    return {
        window_seconds: observedSeconds,
        telemetry_per_second: roundRate(
            (aggregate.telemetry_published || 0) / observedSeconds,
        ),
        telemetry_failures_per_minute: roundRate(
            ((aggregate.telemetry_failed || 0) / observedSeconds) * 60,
        ),
        bytes_per_second: roundRate(
            (aggregate.telemetry_bytes || 0) / observedSeconds,
        ),
        operations_per_second: roundRate(
            (aggregate.operations_received || 0) / observedSeconds,
        ),
    };
};

const roundRate = (value: number): number => Math.round(value * 100) / 100;

export class RunMetricsService {
    private readonly logger: FastifyBaseLogger;
    private pending = new Map<string, RunMetricIncrement>();
    private readonly buckets = new Map<string, RateBucket[]>();
    private flushTimer: NodeJS.Timeout | null = null;
    private flushing = false;

    constructor(logger: FastifyBaseLogger) {
        this.logger = logger.child({ module: 'RunMetricsService' });
    }

    start(): void {
        if (this.flushTimer) return;
        this.flushTimer = setInterval(() => {
            void this.flush().catch((error) => {
                this.logger.error({ err: error }, 'Failed to flush simulator metrics');
            });
        }, env.METRICS_FLUSH_INTERVAL_MS);
        this.flushTimer.unref();
    }

    record(runId: string, increments: RunMetricIncrement): void {
        if (!runId) return;
        const pending = this.pending.get(runId) || {};
        addCounters(pending, increments);
        this.pending.set(runId, pending);

        const second = Math.floor(Date.now() / 1000);
        const buckets = this.buckets.get(runId) || [];
        const current = buckets[buckets.length - 1];
        if (current?.second === second) {
            addCounters(current.counters, increments);
        } else {
            buckets.push({ second, counters: { ...increments } });
        }
        const cutoff = second - env.METRICS_RATE_WINDOW_SECONDS;
        while (buckets[0] && buckets[0].second <= cutoff) buckets.shift();
        this.buckets.set(runId, buckets);
    }

    async snapshot(
        runId: string,
        runtime: RuntimeMetricStats,
    ): Promise<RunMetricsSnapshot | null> {
        const run = await getMongoDb().collection<SimulationRun>('simulation_runs')
            .findOne({ id: runId });
        if (!run) return null;

        const totals = {
            ...emptyMetricTotals(),
            ...(run.metrics?.totals || {}),
        };
        addCounters(totals, this.pending.get(runId) || {});

        const nowSecond = Math.floor(Date.now() / 1000);
        const memory = process.memoryUsage();
        const lastActivity = run.metrics?.last_activity_at;
        return {
            run_id: runId,
            sampled_at: new Date().toISOString(),
            totals,
            rates: calculateWindowRates(
                this.buckets.get(runId) || [],
                nowSecond,
                env.METRICS_RATE_WINDOW_SECONDS,
            ),
            runtime,
            process: {
                rss_bytes: memory.rss,
                heap_used_bytes: memory.heapUsed,
                uptime_seconds: Math.round(process.uptime()),
            },
            ...(lastActivity ? {
                last_activity_at: new Date(lastActivity).toISOString(),
            } : {}),
        };
    }

    async flush(): Promise<void> {
        if (this.flushing || this.pending.size === 0) return;
        this.flushing = true;
        const batch = this.pending;
        this.pending = new Map();

        try {
            await Promise.all([...batch.entries()].map(async ([runId, increments]) => {
                const inc: Record<string, number> = {};
                for (const [name, value] of Object.entries(increments)) {
                    if (value) inc[`metrics.totals.${name}`] = value;
                }
                if (Object.keys(inc).length === 0) return;
                await getMongoDb().collection<SimulationRun>('simulation_runs').updateOne(
                    { id: runId },
                    {
                        $inc: inc,
                        $set: {
                            'metrics.last_activity_at': new Date(),
                            updated_at: new Date(),
                        },
                    },
                );
            }));
        } catch (error) {
            for (const [runId, increments] of batch) {
                const restored = this.pending.get(runId) || {};
                addCounters(restored, increments);
                this.pending.set(runId, restored);
            }
            throw error;
        } finally {
            this.flushing = false;
        }
    }

    async stop(): Promise<void> {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
        await this.flush();
    }
}

let metricsInstance: RunMetricsService | null = null;

export const getRunMetricsService = (logger: FastifyBaseLogger): RunMetricsService => {
    if (!metricsInstance) metricsInstance = new RunMetricsService(logger);
    return metricsInstance;
};
