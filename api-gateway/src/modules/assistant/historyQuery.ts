import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { NOTIFICATION_SEVERITIES } from '../../../../shared/notification-categories';
import { env } from '../../config/env';
import { commandLabels } from '../device/stats';
import type { HistoryDevice } from './context';
import {
    eventDetail,
    factsHead,
    type HistoryFacts,
    type HistoryLookup,
    LIST_LIMIT,
    roundReading,
    timeLabel,
    UNIT_LABELS,
} from './history';

/**
 * Looks up what history.ts checked, with the rules of the screens that show
 * the same data: a device's events and readings only of its current owner and
 * only from the day the person got the device (members: warnings and alerts
 * only); commands since then (members: their own); runs of the account's own
 * scenes and automations. Every query reads an index by device (or account)
 * and time over at most 30 days; results are kept 60 s.
 */

const CACHE_SECONDS = 60;

interface Range {
    from: Date;
    to: Date;
}

/** The period, from the moment the person got the device (never a previous owner's history). */
function rangeFor(device: HistoryDevice, lookup: HistoryLookup): Range {
    const start = lookup.window.start;
    const from = device.joined_at && device.joined_at > start ? device.joined_at : start;
    return { from, to: lookup.window.end };
}

async function events(app: FastifyInstance, lookup: Extract<HistoryLookup, { what: 'events' }>, facts: HistoryFacts) {
    const { device } = lookup;
    if (!device.owner) facts.sees = 'alerts_only';
    const { from, to } = rangeFor(device, lookup);
    const wanted = lookup.events.length > 0 ? lookup.events : device.events;
    if (wanted.length === 0 || from >= to) {
        Object.assign(facts, { total: 0, by_event: [], latest: [] });
        return;
    }
    const base: Record<string, unknown> = {
        device_id: device.mac,
        owner_id: device.owner_id,
        received_at: { $gte: from, $lt: to },
        ...(device.owner ? {} : { severity: { $in: [...NOTIFICATION_SEVERITIES] } }),
    };
    const filter = { ...base, $or: wanted.map(event => ({ instance_id: event.instance_id, event_name: event.event_name })) };
    const collection = app.mongo.db.collection<any>(env.MONGO_DEVICE_EVENTS_COLLECTION);
    const [groups, latest] = await Promise.all([
        collection.aggregate([
            { $match: filter },
            { $group: { _id: { instance: '$instance_id', name: '$event_name' }, count: { $sum: 1 } } },
        ]).toArray(),
        collection.find(filter, { projection: { instance_id: 1, event_name: 1, received_at: 1, data: 1 } })
            .sort({ received_at: -1, _id: -1 }).limit(LIST_LIMIT).toArray(),
    ]);
    // The first and last time of each kind: one indexed read each (a device reports a handful of kinds).
    const edge = async (instance: unknown, name: unknown, order: 1 | -1) => (await collection
        .find({ ...base, instance_id: instance, event_name: name }, { projection: { received_at: 1 } })
        .sort({ received_at: order, _id: order }).limit(1).toArray())[0]?.received_at;
    const labelOf = (instance: unknown, name: unknown) => device.events
        .find(event => event.instance_id === instance && event.event_name === name)?.label ?? String(name);
    const byEvent = (await Promise.all(groups.map(async group => {
        const [first, last] = await Promise.all([
            edge(group._id?.instance, group._id?.name, 1), edge(group._id?.instance, group._id?.name, -1),
        ]);
        return {
            what: labelOf(group._id?.instance, group._id?.name),
            count: Number(group.count),
            first: timeLabel(first ?? from),
            last: timeLabel(last ?? to),
        };
    }))).sort((a, b) => b.count - a.count || a.what.localeCompare(b.what, 'vi'));
    const total = byEvent.reduce((sum, item) => sum + item.count, 0);
    Object.assign(facts, {
        total,
        by_event: byEvent,
        latest: latest.map(row => {
            const detail = eventDetail(row.data);
            return { at: timeLabel(row.received_at), what: labelOf(row.instance_id, row.event_name), ...(detail ? { detail } : {}) };
        }),
        ...(total > latest.length ? { more: true } : {}),
    });
}

async function readings(app: FastifyInstance, lookup: Extract<HistoryLookup, { what: 'readings' }>, facts: HistoryFacts) {
    const { device, reading } = lookup;
    const { from, to } = rangeFor(device, lookup);
    Object.assign(facts, {
        reading: reading.instance_label === reading.label ? reading.label : `${reading.instance_label} · ${reading.label}`,
        ...(reading.unit ? { unit: UNIT_LABELS[reading.unit] ?? reading.unit } : {}),
    });
    if (from >= to) {
        facts.samples = 0;
        return;
    }
    const path = reading.property;
    const match = {
        'metadata.device_id': device.mac,
        'metadata.owner_id': device.owner_id,
        observed_at: { $gte: from, $lt: to },
        [path]: { $exists: true },
    };
    const collection = app.mongo.db.collection<any>(env.MONGO_DEVICE_TELEMETRY_COLLECTION);
    // Highest and lowest (the latest time when repeated) and the last reading: one read each, sorted.
    const one = (sort: Record<string, 1 | -1>) => collection
        .find(match, { projection: { observed_at: 1, [path]: 1 } }).sort(sort).limit(1).toArray();
    const [samples, [summary], [highest], [lowest], [last]] = await Promise.all([
        collection.countDocuments(match),
        collection.aggregate([{ $match: match }, { $group: { _id: null, total: { $sum: `$${path}` } } }]).toArray(),
        one({ [path]: -1, observed_at: -1 }),
        one({ [path]: 1, observed_at: -1 }),
        one({ observed_at: -1 }),
    ]);
    const valueOf = (row: any) => path.split('.').reduce<any>((node, key) => node?.[key], row);
    if (!samples || typeof valueOf(highest) !== 'number' || typeof valueOf(lowest) !== 'number') {
        facts.samples = 0;
        return;
    }
    const value = (raw: number) => roundReading(raw, reading.precision);
    Object.assign(facts, {
        samples,
        highest: { value: value(valueOf(highest)), at: timeLabel(highest.observed_at) },
        lowest: { value: value(valueOf(lowest)), at: timeLabel(lowest.observed_at) },
        average: value(Number(summary.total) / samples),
        ...(typeof valueOf(last) === 'number' ? { latest: { value: value(valueOf(last)), at: timeLabel(last.observed_at) } } : {}),
    });
}

const RESULTS: Record<string, string> = {
    succeeded: 'thành công', failed: 'không thành công', rejected: 'bị từ chối', timed_out: 'thiết bị không phản hồi',
};

async function commands(
    app: FastifyInstance,
    accountId: string,
    lookup: Extract<HistoryLookup, { what: 'commands' }>,
    facts: HistoryFacts,
) {
    const { device } = lookup;
    const { from, to } = rangeFor(device, lookup);
    if (!device.owner) facts.only_yours = true;
    const labels = commandLabels(app.catalog.getProduct(device.product_id));
    const keys = [...labels.keys()];
    if (!device.device_id || keys.length === 0 || from >= to) {
        Object.assign(facts, { total: 0, by_command: [], latest: [] });
        return;
    }
    // The owner sees who sent each command; a member only their own.
    const params = [device.device_id, from, to, keys, device.owner ? null : accountId];
    const where = `operation.device_id = $1 AND operation.created_at >= $2 AND operation.created_at < $3
          AND operation.instance_id || '.' || operation.operation_name = ANY($4::text[])
          AND operation.status IN ('succeeded', 'failed', 'rejected', 'timed_out')
          AND ($5::uuid IS NULL OR operation.actor_account_id = $5)`;
    const [grouped, latest] = await Promise.all([
        app.pg.query(
            `SELECT operation.instance_id || '.' || operation.operation_name AS key,
                    COUNT(*)::int AS count,
                    COUNT(*) FILTER (WHERE operation.status = 'succeeded')::int AS succeeded
             FROM device_operations AS operation
             WHERE ${where}
             GROUP BY 1`,
            params,
        ),
        app.pg.query(
            `SELECT operation.instance_id || '.' || operation.operation_name AS key, operation.status,
                    operation.created_at, operation.actor_account_id, account.full_name
             FROM device_operations AS operation
             JOIN accounts AS account ON account.id = operation.actor_account_id
             WHERE ${where}
             ORDER BY operation.created_at DESC, operation.id DESC
             LIMIT ${LIST_LIMIT}`,
            params,
        ),
    ]);
    const byCommand = grouped.rows
        .map(row => ({
            what: labels.get(row.key) ?? row.key,
            count: row.count,
            ...(row.succeeded !== row.count ? { not_succeeded: row.count - row.succeeded } : {}),
        }))
        .sort((a, b) => b.count - a.count || a.what.localeCompare(b.what, 'vi'));
    const total = byCommand.reduce((sum, item) => sum + item.count, 0);
    Object.assign(facts, {
        total,
        by_command: byCommand,
        latest: latest.rows.map(row => ({
            at: timeLabel(row.created_at),
            what: labels.get(row.key) ?? row.key,
            by: row.actor_account_id === accountId ? 'bạn' : String(row.full_name),
            ...(row.status !== 'succeeded' ? { result: RESULTS[row.status] ?? row.status } : {}),
        })),
        ...(total > latest.rows.length ? { more: true } : {}),
    });
}

const HOW: Record<string, string> = { manual: 'chạy bằng tay', schedule: 'theo hẹn giờ', automation: 'do tự động hóa' };
const RUN_RESULTS: Record<string, string> = {
    succeeded: 'thành công', partial: 'chỉ xong một phần', failed: 'thất bại', running: 'đang chạy',
};

async function runs(app: FastifyInstance, accountId: string, lookup: Extract<HistoryLookup, { what: 'runs' }>, facts: HistoryFacts) {
    const { from, to } = { from: lookup.window.start, to: lookup.window.end };
    const automation = lookup.automation;
    facts.of = lookup.scene?.name ?? automation?.name ?? null;
    if (automation && !automation.has_scene) {
        // An automation that only notifies leaves its notifications.
        const result = await app.pg.query(
            `SELECT created_at FROM account_notifications
             WHERE account_id = $1 AND automation_id = $2 AND created_at >= $3 AND created_at < $4
             ORDER BY created_at DESC LIMIT 500`,
            [accountId, automation.automation_id, from, to],
        );
        Object.assign(facts, {
            total: result.rows.length,
            latest: result.rows.slice(0, LIST_LIMIT).map(row => ({ at: timeLabel(row.created_at), result: 'đã gửi thông báo' })),
            ...(result.rows.length > LIST_LIMIT ? { more: true } : {}),
        });
        return;
    }
    const params: unknown[] = [accountId, from, to];
    let target = '';
    if (lookup.scene) {
        params.push(lookup.scene.scene_id);
        target = 'AND run.scene_id = $4';
    } else if (automation) {
        params.push(automation.automation_id);
        target = 'AND run.automation_id = $4';
    }
    const where = `run.account_id = $1 AND run.started_at >= $2 AND run.started_at < $3 ${target}`;
    const [grouped, latest] = await Promise.all([
        app.pg.query(
            `SELECT run.scene_name AS name, COUNT(*)::int AS count FROM scene_runs AS run WHERE ${where} GROUP BY 1`,
            params,
        ),
        app.pg.query(
            `SELECT run.scene_name, run.trigger, run.status, run.started_at, automation.name AS automation_name
             FROM scene_runs AS run
             LEFT JOIN automations AS automation ON automation.id = run.automation_id
             WHERE ${where}
             ORDER BY run.started_at DESC, run.id DESC
             LIMIT ${LIST_LIMIT}`,
            params,
        ),
    ]);
    const total = grouped.rows.reduce((sum, row) => sum + row.count, 0);
    Object.assign(facts, {
        total,
        ...(lookup.scene || automation ? {} : {
            by_scene: grouped.rows
                .map(row => ({ name: row.name, count: row.count }))
                .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'vi')),
        }),
        latest: latest.rows.map(row => ({
            at: timeLabel(row.started_at),
            ...(lookup.scene ? {} : { scene: row.scene_name }),
            how: row.trigger === 'automation' && row.automation_name
                ? `do tự động hóa "${row.automation_name}"` : HOW[row.trigger] ?? row.trigger,
            result: RUN_RESULTS[row.status] ?? row.status,
        })),
        ...(total > latest.rows.length ? { more: true } : {}),
    });
}

function cacheKey(accountId: string, lookup: HistoryLookup): string {
    const target = lookup.what === 'runs'
        ? `${lookup.scene?.scene_id ?? ''}:${lookup.automation?.automation_id ?? ''}`
        : `${lookup.device.mac}:${lookup.device.owner_id}:${lookup.device.joined_at?.getTime() ?? ''}:${
            lookup.what === 'readings' ? lookup.reading.property
                : lookup.what === 'events' ? lookup.events.map(event => `${event.instance_id}.${event.event_name}`).sort().join(',') : ''}`;
    const digest = crypto.createHash('sha256')
        // The end moves with the clock: one entry per minute is enough.
        .update(`${lookup.what}|${target}|${lookup.window.start.getTime()}|${Math.floor(lookup.window.end.getTime() / 60_000)}|${lookup.window.label}`)
        .digest('base64url');
    return `assistant:history:v1:${accountId}:${digest}`;
}

export async function lookUpHistory(app: FastifyInstance, accountId: string, lookup: HistoryLookup): Promise<HistoryFacts> {
    const facts = factsHead(lookup);
    if (lookup.window.too_old) return facts;
    const key = cacheKey(accountId, lookup);
    const cached = await app.redis.get(key).catch(() => null);
    if (cached) return JSON.parse(cached);
    try {
        switch (lookup.what) {
            case 'events': await events(app, lookup, facts); break;
            case 'readings': await readings(app, lookup, facts); break;
            case 'commands': await commands(app, accountId, lookup, facts); break;
            case 'runs': await runs(app, accountId, lookup, facts); break;
        }
    } catch (error) {
        app.log.warn({ error, what: lookup.what }, 'An assistant history lookup failed');
        return { ...factsHead(lookup), error: true };
    }
    await app.redis.set(key, JSON.stringify(facts), 'EX', CACHE_SECONDS).catch(() => undefined);
    return facts;
}
