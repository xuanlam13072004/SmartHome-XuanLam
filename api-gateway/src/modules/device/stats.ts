import { FastifyInstance } from 'fastify';
import { env } from '../../config/env';
import { httpError } from '../../utils/httpError';
import { NOTIFICATION_SEVERITIES } from '../../../../shared/notification-categories';
import { eventLabel } from '../automations/labels';
import { instanceLabel } from '../scenes/actions';

/**
 * "Biểu đồ hoạt động" of one device: hourly or daily numbers the app draws.
 * - measures: average / lowest / highest of each sampled numeric reading
 *   (MongoDB device_telemetry, kept 30 days);
 * - events: what the device reported (MongoDB device_events);
 * - commands: operations that succeeded (PostgreSQL device_operations).
 *
 * Everyone sees data only from the moment they got the device (owner: claim,
 * member: joined) and only of the current owner. Members, like in the
 * notification center, count warnings and alerts only; the owner counts every
 * event, like the device's history.
 */

export const STATS_RANGES = ['24h', '7d', '30d'] as const;
export type StatsRange = typeof STATS_RANGES[number];
export type StatsUnit = 'hour' | 'day';

/** Days and hours are cut in Vietnam time, a fixed UTC+7 (no daylight saving). */
export const STATS_TIMEZONE = 'Asia/Ho_Chi_Minh';
const OFFSET_MS = 7 * 3_600_000;
const SIZE_MS: Record<StatsUnit, number> = { hour: 3_600_000, day: 86_400_000 };
const RANGE: Record<StatsRange, { unit: StatsUnit; count: number; cacheSeconds: number }> = {
    '24h': { unit: 'hour', count: 24, cacheSeconds: 120 },
    '7d': { unit: 'day', count: 7, cacheSeconds: 600 },
    '30d': { unit: 'day', count: 30, cacheSeconds: 600 },
};

export interface StatsWindow {
    unit: StatsUnit;
    /** Bucket length in milliseconds. */
    size: number;
    /** Start of the first bucket; bucket i starts at start + i × size. */
    start: Date;
    end: Date;
    count: number;
}

/** The buckets of [range] ending with the one [now] is in (24 hours, 7 or 30 days). */
export function statsWindow(range: StatsRange, now: Date): StatsWindow {
    const { unit, count } = RANGE[range];
    const size = SIZE_MS[unit];
    const current = Math.floor((now.getTime() + OFFSET_MS) / size) * size - OFFSET_MS;
    return { unit, size, start: new Date(current - (count - 1) * size), end: now, count };
}

export function bucketStarts(window: StatsWindow): string[] {
    return Array.from({ length: window.count }, (_, index) =>
        new Date(window.start.getTime() + index * window.size).toISOString());
}

/** MongoDB expression: index of the bucket [field] falls in (the same rule as statsWindow). */
function bucketOf(field: string, window: StatsWindow) {
    return { $floor: { $divide: [{ $subtract: [`$${field}`, window.start] }, window.size] } };
}

export interface ChartMeasure {
    property: string;
    label: string;
    instance_label: string;
    unit: string | null;
    minimum: number | null;
    maximum: number | null;
    precision: number;
}

/**
 * Readings worth a chart: numbers the catalog samples into history and that
 * have a range (temperature, gas level, Wi-Fi signal...). Counters without an
 * upper bound (uptime, bytes stored) say nothing as an hourly average.
 */
export function chartMeasures(product: any): ChartMeasure[] {
    const result: ChartMeasure[] = [];
    for (const [path, schema] of Object.entries((product?.property_schemas ?? {}) as Record<string, any>)) {
        if (schema.history !== 'sampled') continue;
        if (schema.type !== 'number' && schema.type !== 'integer') continue;
        if (typeof schema.maximum !== 'number' || schema.presentation?.ui_hint === 'hidden') continue;
        result.push({
            property: path,
            label: String(schema.presentation?.label || schema.id || path),
            instance_label: instanceLabel(product, path.split('.')[1] ?? ''),
            unit: schema.unit ? String(schema.unit) : null,
            minimum: typeof schema.minimum === 'number' ? schema.minimum : null,
            maximum: schema.maximum,
            precision: typeof schema.precision === 'number' ? schema.precision : (schema.type === 'integer' ? 0 : 1),
        });
    }
    return result;
}

export function telemetryPipeline(input: {
    mac: string;
    ownerId: string;
    from: Date;
    window: StatsWindow;
    paths: string[];
}) {
    const group: Record<string, unknown> = { _id: bucketOf('observed_at', input.window) };
    input.paths.forEach((path, index) => {
        group[`avg${index}`] = { $avg: `$${path}` };
        group[`min${index}`] = { $min: `$${path}` };
        group[`max${index}`] = { $max: `$${path}` };
    });
    return [
        {
            $match: {
                'metadata.device_id': input.mac,
                'metadata.owner_id': input.ownerId,
                observed_at: { $gte: input.from, $lte: input.window.end },
            },
        },
        { $group: group },
    ];
}

export function eventPipeline(input: {
    mac: string;
    ownerId: string;
    from: Date;
    window: StatsWindow;
    alertsOnly: boolean;
}) {
    return [
        {
            $match: {
                device_id: input.mac,
                owner_id: input.ownerId,
                received_at: { $gte: input.from, $lte: input.window.end },
                ...(input.alertsOnly ? { severity: { $in: [...NOTIFICATION_SEVERITIES] } } : {}),
            },
        },
        {
            $group: {
                _id: { bucket: bucketOf('received_at', input.window), name: '$event_name' },
                count: { $sum: 1 },
            },
        },
    ];
}

export interface MeasurePoint {
    avg: number;
    min: number;
    max: number;
}

function round(value: number, precision: number): number {
    const factor = 10 ** Math.min(Math.max(precision, 0), 3);
    return Math.round(value * factor) / factor;
}

function slot(id: unknown, count: number): number | null {
    const index = Number(id);
    return Number.isInteger(index) && index >= 0 && index < count ? index : null;
}

/** One series per measure, a point (or null: no reading) per bucket. */
export function shapeMeasures(measures: ChartMeasure[], rows: any[], count: number) {
    const series = measures.map(measure => ({ ...measure, points: new Array<MeasurePoint | null>(count).fill(null) }));
    for (const row of rows) {
        const index = slot(row._id, count);
        if (index === null) continue;
        series.forEach((item, at) => {
            const avg = row[`avg${at}`];
            const min = row[`min${at}`];
            const max = row[`max${at}`];
            if (typeof avg !== 'number' || typeof min !== 'number' || typeof max !== 'number') return;
            item.points[index] = {
                avg: round(avg, item.precision),
                min: round(min, item.precision),
                max: round(max, item.precision),
            };
        });
    }
    return series;
}

export interface CountedItem {
    key: string;
    label: string;
    count: number;
}

/** Totals per bucket and per kind (most frequent first) from (bucket, key, count) rows. */
export function shapeCounts(
    rows: Array<{ bucket: unknown; key: string; count: number }>,
    count: number,
    label: (key: string) => string,
) {
    const perBucket = new Array<number>(count).fill(0);
    const byKey = new Map<string, number>();
    for (const row of rows) {
        const index = slot(row.bucket, count);
        if (index === null || !(row.count > 0)) continue;
        perBucket[index] += row.count;
        byKey.set(row.key, (byKey.get(row.key) ?? 0) + row.count);
    }
    const items: CountedItem[] = [...byKey.entries()]
        .map(([key, total]) => ({ key, label: label(key), count: total }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'vi'));
    return { total: perBucket.reduce((sum, value) => sum + value, 0), per_bucket: perBucket, items };
}

/** Name of a counted command; query operations (listing recordings) are not commands. */
export function commandLabels(product: any): Map<string, string> {
    const labels = new Map<string, string>();
    for (const [key, operation] of Object.entries((product?.operations ?? {}) as Record<string, any>)) {
        if (operation.presentation?.ui_hint === 'query') continue;
        labels.set(key, String(operation.presentation?.label || key));
    }
    return labels;
}

interface StatsDevice {
    id: string;
    owner_id: string;
    product_id: string;
    role: string;
    joined_at: Date;
}

async function loadStatsDevice(app: FastifyInstance, mac: string, accountId: string): Promise<StatsDevice | null> {
    const result = await app.pg.query(
        `SELECT device.id, device.owner_id, device.product_id, membership.role, membership.created_at AS joined_at
         FROM device_metadata AS device
         JOIN device_memberships AS membership
           ON membership.device_id = device.id
          AND membership.account_id = $1
          AND membership.status = 'active'
          AND (membership.expires_at IS NULL OR membership.expires_at > NOW())
         WHERE device.mac = $2 AND device.is_active = true`,
        [accountId, mac],
    );
    return result.rows[0] ?? null;
}

async function countCommands(app: FastifyInstance, deviceId: string, from: Date, window: StatsWindow) {
    const result = await app.pg.query(
        `SELECT floor(EXTRACT(EPOCH FROM (created_at - $3::timestamptz)) * 1000 / $4::numeric)::int AS bucket,
                instance_id || '.' || operation_name AS key,
                COUNT(*)::int AS count
         FROM device_operations
         WHERE device_id = $1 AND status = 'succeeded'
           AND created_at >= $2 AND created_at <= $5
         GROUP BY 1, 2`,
        [deviceId, from, window.start, window.size, window.end],
    );
    return result.rows as Array<{ bucket: number; key: string; count: number }>;
}

export async function getDeviceStats(app: FastifyInstance, macInput: string, accountId: string, range: StatsRange) {
    const mac = macInput.trim().toUpperCase();
    const device = await loadStatsDevice(app, mac, accountId);
    if (!device) throw httpError(403, 'DEVICE_FORBIDDEN', 'Forbidden');

    const now = new Date();
    const window = statsWindow(range, now);
    const joinedAt = new Date(device.joined_at);
    const from = joinedAt > window.start ? joinedAt : window.start;
    const owner = device.role === 'owner';
    const cacheKey = [
        'device_stats:v1', mac, range, device.owner_id, owner ? 'owner' : `member:${joinedAt.getTime()}`,
        window.start.getTime(),
    ].join(':');
    const cached = await app.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const product = app.catalog.getProduct(device.product_id);
    const measures = chartMeasures(product);
    const labels = commandLabels(product);
    const ownerId = String(device.owner_id);
    const db = app.mongo.db;
    const [telemetry, events, commands] = await Promise.all([
        measures.length === 0 ? Promise.resolve([]) : db
            .collection(env.MONGO_DEVICE_TELEMETRY_COLLECTION)
            .aggregate(telemetryPipeline({ mac, ownerId, from, window, paths: measures.map(item => item.property) }))
            .toArray(),
        db.collection(env.MONGO_DEVICE_EVENTS_COLLECTION)
            .aggregate(eventPipeline({ mac, ownerId, from, window, alertsOnly: !owner }))
            .toArray(),
        countCommands(app, device.id, from, window),
    ]);

    const eventCounts = shapeCounts(
        events.map(row => ({ bucket: row._id?.bucket, key: String(row._id?.name), count: Number(row.count) })),
        window.count,
        eventLabel,
    );
    const commandCounts = shapeCounts(
        commands.filter(row => labels.has(row.key)),
        window.count,
        key => labels.get(key) ?? key,
    );
    const stats = {
        range,
        unit: window.unit,
        timezone: STATS_TIMEZONE,
        buckets: bucketStarts(window),
        since: from > window.start ? from.toISOString() : null,
        measures: shapeMeasures(measures, telemetry, window.count),
        events: {
            scope: owner ? 'all' : 'alerts',
            total: eventCounts.total,
            per_bucket: eventCounts.per_bucket,
            by_name: eventCounts.items.map(item => ({ event_name: item.key, label: item.label, count: item.count })),
        },
        commands: {
            total: commandCounts.total,
            per_bucket: commandCounts.per_bucket,
            by_operation: commandCounts.items.map(item => ({ operation: item.key, label: item.label, count: item.count })),
        },
        generated_at: now.toISOString(),
    };
    await app.redis.set(cacheKey, JSON.stringify(stats), 'EX', RANGE[range].cacheSeconds);
    return stats;
}
