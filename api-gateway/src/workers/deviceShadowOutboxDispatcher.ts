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
    device_id: string | null;
    mac: string;
    operation: 'claim' | 'upsert' | 'rename' | 'unpair';
    payload: Record<string, any>;
};

async function applyGuardedUpdate(
    mongoDb: Db,
    event: ShadowEvent,
    fields: Record<string, unknown>,
    upsert = false,
) {
    const collection = mongoDb.collection<any>(env.MONGO_DEVICE_SHADOWS_COLLECTION);
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
            updated_at: new Date(),
        },
    };
    try {
        await collection.updateOne(filter, update, { upsert });
    } catch (error: any) {
        if (!upsert || error?.code !== 11000) throw error;
        await collection.updateOne(filter, update);
    }
}

async function applyEvent(mongoDb: Db, event: ShadowEvent) {
    const payload = event.payload || {};
    if (event.operation === 'claim' || event.operation === 'upsert') {
        await applyGuardedUpdate(
            mongoDb,
            event,
            {
                device_id: event.device_id,
                owner_id: payload.owner_id,
                product_id: payload.product_id,
                catalog_revision: Number(payload.catalog_revision),
                name: payload.name,
                access_account_ids: payload.access_account_ids || [payload.owner_id],
                state_version: 0,
                instances: {},
                diagnostics: {},
                is_online: false,
                last_seen: null,
            },
            true,
        );
        return;
    }
    if (event.operation === 'rename') {
        await applyGuardedUpdate(mongoDb, event, { name: payload.name });
        return;
    }

    await Promise.all([
        mongoDb.collection<any>(env.MONGO_DEVICE_SHADOWS_COLLECTION).deleteOne({ _id: event.mac }),
        mongoDb.collection<any>(env.MONGO_ACTIVE_OPERATIONS_COLLECTION).deleteMany({ device_id: event.mac }),
        mongoDb.collection<any>(env.MONGO_DEVICE_TELEMETRY_COLLECTION).deleteMany({
            'metadata.device_id': event.mac,
        }),
        mongoDb.collection<any>(env.MONGO_DEVICE_EVENTS_COLLECTION).deleteMany({ device_id: event.mac }),
        mongoDb.collection<any>(env.MONGO_DEVICE_INCIDENTS_COLLECTION).deleteMany({ device_id: event.mac }),
        mongoDb.collection<any>(env.MONGO_INGEST_RECEIPTS_COLLECTION).deleteMany({ device_id: event.mac }),
    ]);
}

export async function dispatchDeviceShadowOutboxEvent(
    pgPool: Pool,
    mongoDb: Db,
    logger: Logger,
    eventId: number,
) {
    const result = await pgPool.query(
        `SELECT current.id, current.device_id, current.mac,
                current.operation, current.payload
         FROM device_shadow_outbox AS current
         WHERE current.id = $1
           AND current.processed_at IS NULL
           AND current.available_at <= NOW()
           AND NOT EXISTS (
             SELECT 1 FROM device_shadow_outbox AS earlier
             WHERE earlier.mac = current.mac
               AND earlier.processed_at IS NULL
               AND earlier.id < current.id
           )`,
        [eventId],
    );
    if (result.rows.length === 0) return;

    const event = result.rows[0] as ShadowEvent;
    try {
        await applyEvent(mongoDb, event);
        await pgPool.query(
            `UPDATE device_shadow_outbox
             SET processed_at = NOW(), attempt_count = attempt_count + 1,
                 last_error = NULL
             WHERE id = $1 AND processed_at IS NULL`,
            [event.id],
        );
        logger.debug({ eventId: event.id, mac: event.mac }, 'Device shadow event applied');
    } catch (error: any) {
        await pgPool.query(
            `UPDATE device_shadow_outbox
             SET attempt_count = attempt_count + 1,
                 available_at = NOW() + LEAST(300, POWER(2, LEAST(attempt_count, 8))) * INTERVAL '1 second',
                 last_error = $2
             WHERE id = $1`,
            [event.id, String(error?.message || error).slice(0, 2000)],
        ).catch(updateError => logger.warn(
            { updateError, eventId: event.id },
            'Failed to record device shadow outbox error',
        ));
        throw error;
    }
}

export class DeviceShadowOutboxDispatcher {
    private timer: NodeJS.Timeout | null = null;
    private running = false;
    private inFlight: Promise<void> | null = null;

    constructor(
        private readonly pgPool: Pool,
        private readonly mongoDb: Db,
        private readonly logger: Logger,
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
                .catch(error => this.logger.error({ error }, 'Device shadow outbox dispatch failed'))
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
               AND current.available_at <= NOW()
               AND NOT EXISTS (
                 SELECT 1 FROM device_shadow_outbox AS earlier
                 WHERE earlier.mac = current.mac
                   AND earlier.processed_at IS NULL
                   AND earlier.id < current.id
               )
             ORDER BY current.id ASC
             LIMIT 50`,
        );
        for (const row of result.rows) {
            await dispatchDeviceShadowOutboxEvent(
                this.pgPool,
                this.mongoDb,
                this.logger,
                Number(row.id),
            ).catch(error => this.logger.warn(
                { error, eventId: row.id },
                'Device shadow event will be retried',
            ));
        }
    }

    async stop() {
        this.running = false;
        if (this.timer) clearTimeout(this.timer);
        if (this.inFlight) await this.inFlight;
    }
}
