import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env';

/**
 * How long telemetry takes from the device's clock to the database, over the
 * last 30 seconds (docs/architecture/load-testing.md): the Console's load-test
 * page shows it next to what the Simulator sends. Measured by the backend on
 * its own data, so the Simulator never reads the system's databases.
 * Cross-machine runs need synchronized clocks (observed_at is the device's).
 */
export interface IngestLatency {
    samples: number;
    p50_ms: number;
    p95_ms: number;
    max_ms: number;
}

const WINDOW_MS = 30_000;
const MAX_SAMPLES = 5000;
const CACHE_MS = 5000;

const percentile = (sorted: number[], fraction: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];

export function measureIngestLatency(rows: Array<{ observed_at?: Date; ingested_at?: Date }>): IngestLatency | null {
    const values = rows
        .filter(row => row.observed_at && row.ingested_at)
        .map(row => Math.max(0, new Date(row.ingested_at as Date).getTime() - new Date(row.observed_at as Date).getTime()))
        .sort((left, right) => left - right);
    if (values.length === 0) return null;
    return {
        samples: values.length,
        p50_ms: percentile(values, 0.5),
        p95_ms: percentile(values, 0.95),
        max_ms: values[values.length - 1],
    };
}

let cached: { at: number; value: IngestLatency | null } | null = null;

/** The last 30 s of telemetry, read at most once per 5 s whatever the number of Console tabs. */
export async function recentIngestLatency(app: FastifyInstance): Promise<IngestLatency | null> {
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
    const rows = await app.mongo.db.collection(env.MONGO_DEVICE_TELEMETRY_COLLECTION)
        .find(
            { observed_at: { $gte: new Date(Date.now() - WINDOW_MS) } },
            { projection: { _id: 0, observed_at: 1, ingested_at: 1 } },
        )
        .limit(MAX_SAMPLES)
        .toArray();
    const value = measureIngestLatency(rows as Array<{ observed_at?: Date; ingested_at?: Date }>);
    cached = { at: Date.now(), value };
    return value;
}
