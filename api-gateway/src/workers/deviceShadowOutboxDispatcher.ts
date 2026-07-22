import type { Pool } from 'pg';
import type { Db } from 'mongodb';
import { env } from '../config/env';

type Logger = {
    debug: (obj: unknown, message?: string) => void;
    warn: (obj: unknown, message?: string) => void;
    error: (obj: unknown, message?: string) => void;
};

type ShadowEvent = {
    id: number;
    mac: string;
    operation: 'upsert' | 'unpair' | 'rename';
    payload: Record<string, any>;
};

async function applyMonotonicUpdate(
    mongoDb: Db,
    event: ShadowEvent,
    fields: Record<string, unknown>,
    upsert = false
) {
    const devices = mongoDb.collection<any>(env.MONGO_DEVICES_COLLECTION);
    const filter = {
        _id: event.mac,
        $or: [
            { shadow_outbox_event_id: { $exists: false } },
            { shadow_outbox_event_id: { $lt: event.id } },
        ],
    };
    const update = {
        $set: {
            ...fields,
            shadow_outbox_event_id: event.id,
        },
    };

    try {
        await devices.updateOne(filter, update, { upsert });
    } catch (err: any) {
        // With upsert enabled, an already-applied/newer event no longer
        // matches the guarded filter and Mongo attempts an _id insert. Treat
        // that duplicate-key race as a no-op (or apply once if this event won).
        if (!upsert || err?.code !== 11000) throw err;
        await devices.updateOne(filter, update);
    }
}

async function applyEvent(mongoDb: Db, event: ShadowEvent) {
    const payload = event.payload || {};

    if (event.operation === 'upsert') {
        await applyMonotonicUpdate(
            mongoDb,
            event,
            {
                owner_id: payload.owner_id,
                product_id: payload.product_id,
                name: payload.name,
                state: payload.default_state || {},
                diagnostics: {},
                is_online: false,
                last_updated: new Date(),
            },
            true
        );
        return;
    }

    if (event.operation === 'unpair') {
        await applyMonotonicUpdate(
            mongoDb,
            event,
            {
                owner_id: null,
                name: null,
                is_online: false,
                last_updated: new Date(),
            }
        );
        return;
    }

    await applyMonotonicUpdate(mongoDb, event, {
        name: payload.name,
        last_updated: new Date(),
    });
}

export async function dispatchDeviceShadowOutboxEvent(
    pgPool: Pool,
    mongoDb: Db,
    logger: Logger,
    eventId: number
) {
    const result = await pgPool.query(
        `SELECT id, mac, operation, payload
         FROM device_shadow_outbox AS current
         WHERE id = $1
           AND processed_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM device_shadow_outbox AS earlier
             WHERE earlier.mac = current.mac
               AND earlier.processed_at IS NULL
               AND earlier.id < current.id
           )`,
        [eventId]
    );
    if (result.rows.length === 0) return;

    const event = result.rows[0] as ShadowEvent;
    try {
        await applyEvent(mongoDb, event);
        await pgPool.query(
            `UPDATE device_shadow_outbox
             SET processed_at = NOW(), attempts = attempts + 1,
                 last_error = NULL, updated_at = NOW()
             WHERE id = $1 AND processed_at IS NULL`,
            [event.id]
        );
        logger.debug({ eventId: event.id, mac: event.mac }, 'Device shadow outbox event applied');
    } catch (err: any) {
        await pgPool.query(
            `UPDATE device_shadow_outbox
             SET attempts = attempts + 1, last_error = $2, updated_at = NOW()
             WHERE id = $1`,
            [event.id, String(err?.message || err).slice(0, 2000)]
        ).catch(updateErr => logger.warn({ updateErr, eventId: event.id }, 'Failed to record shadow outbox error'));
        throw err;
    }
}

export class DeviceShadowOutboxDispatcher {
    private timer: NodeJS.Timeout | null = null;
    private running = false;
    private inFlight: Promise<void> | null = null;

    constructor(
        private readonly pgPool: Pool,
        private readonly mongoDb: Db,
        private readonly logger: Logger
    ) {}

    start() {
        if (this.running) return;
        this.running = true;
        this.schedule(0);
    }

    private schedule(delayMs: number) {
        if (!this.running) return;
        this.timer = setTimeout(() => {
            this.inFlight = this.dispatchBatch()
                .catch(err => this.logger.error({ err }, 'Device shadow outbox dispatch failed'))
                .finally(() => {
                    this.inFlight = null;
                    this.schedule(1000);
                });
        }, delayMs);
        this.timer.unref();
    }

    private async dispatchBatch() {
        const result = await this.pgPool.query(
            `SELECT current.id
             FROM device_shadow_outbox AS current
             WHERE current.processed_at IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM device_shadow_outbox AS earlier
                 WHERE earlier.mac = current.mac
                   AND earlier.processed_at IS NULL
                   AND earlier.id < current.id
               )
             ORDER BY current.id ASC
             LIMIT 50`
        );

        for (const row of result.rows) {
            await dispatchDeviceShadowOutboxEvent(
                this.pgPool,
                this.mongoDb,
                this.logger,
                Number(row.id)
            ).catch(err => this.logger.warn({ err, eventId: row.id }, 'Shadow event will be retried'));
        }
    }

    async stop() {
        this.running = false;
        if (this.timer) clearTimeout(this.timer);
        if (this.inFlight) await this.inFlight;
    }
}
