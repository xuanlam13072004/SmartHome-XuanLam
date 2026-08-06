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

type CatalogReader = {
    getProduct: (productId: string) => { permissions?: string[] } | null;
};

type ShadowAccessGrant = {
    account_id: string;
    role: string;
    permissions: string[];
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
                // Store permissions snapshot so Real-Time Service can serve initial_state
                // without a Postgres join. Owner gets full catalog permissions.
                owner_permissions: Array.isArray(payload.owner_permissions)
                    ? payload.owner_permissions
                    : [],
                access_grants: Array.isArray(payload.access_grants)
                    ? payload.access_grants
                    : [{
                        account_id: payload.owner_id,
                        role: 'owner',
                        permissions: Array.isArray(payload.owner_permissions)
                            ? payload.owner_permissions
                            : [],
                    }],
                is_active: true,
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

/**
 * Rebuild the access projection stored alongside device shadows.
 *
 * PostgreSQL remains authoritative for ownership and membership. MongoDB keeps
 * this projection only so the realtime service can build an initial snapshot
 * without opening a PostgreSQL connection. Running this at startup also
 * backfills shadows created before access metadata was introduced.
 */
export async function synchronizeDeviceShadowAccessProjection(
    pgPool: Pool,
    mongoDb: Db,
    catalog: CatalogReader,
    logger: Logger,
) {
    const result = await pgPool.query(
        `SELECT device.id AS device_id, device.mac, device.owner_id,
                device.product_id, device.catalog_revision, device.name,
                membership.account_id, membership.role,
                COALESCE(
                    ARRAY_AGG(permission.permission_scope)
                        FILTER (WHERE permission.permission_scope IS NOT NULL),
                    ARRAY[]::text[]
                ) AS granted_permissions
         FROM device_metadata AS device
         JOIN device_memberships AS membership
           ON membership.device_id = device.id
          AND membership.status = 'active'
          AND (membership.expires_at IS NULL OR membership.expires_at > NOW())
         LEFT JOIN device_membership_permissions AS permission
           ON permission.device_id = membership.device_id
          AND permission.account_id = membership.account_id
         WHERE device.is_active = true
         GROUP BY device.id, membership.account_id, membership.role
         ORDER BY device.mac, membership.account_id`,
    );

    const projections = new Map<string, {
        device_id: string;
        owner_id: string;
        product_id: string;
        catalog_revision: number;
        name: string;
        owner_permissions: string[];
        access_grants: ShadowAccessGrant[];
    }>();

    for (const row of result.rows) {
        let projection = projections.get(row.mac);
        if (!projection) {
            const product = catalog.getProduct(row.product_id);
            projection = {
                device_id: row.device_id,
                owner_id: row.owner_id,
                product_id: row.product_id,
                catalog_revision: Number(row.catalog_revision),
                name: row.name,
                owner_permissions: Array.isArray(product?.permissions)
                    ? product.permissions
                    : [],
                access_grants: [],
            };
            projections.set(row.mac, projection);
        }

        const isOwner = row.role === 'owner' || row.account_id === row.owner_id;
        projection.access_grants.push({
            account_id: row.account_id,
            role: isOwner ? 'owner' : row.role,
            permissions: isOwner
                ? projection.owner_permissions
                : (Array.isArray(row.granted_permissions)
                    ? row.granted_permissions
                    : []),
        });
    }

    if (projections.size === 0) {
        logger.debug({}, 'No active device shadow access projections to synchronize');
        return;
    }

    const collection = mongoDb.collection<any>(env.MONGO_DEVICE_SHADOWS_COLLECTION);
    const writeResult = await collection.bulkWrite(
        Array.from(projections.entries()).map(([mac, projection]) => ({
            updateOne: {
                filter: { _id: mac },
                update: {
                    $set: {
                        ...projection,
                        access_account_ids: projection.access_grants
                            .map(grant => grant.account_id),
                        is_active: true,
                    },
                },
                upsert: false,
            },
        })),
        { ordered: false },
    );

    logger.debug(
        {
            projected: projections.size,
            matched: writeResult.matchedCount,
            modified: writeResult.modifiedCount,
        },
        'Device shadow access projections synchronized from PostgreSQL',
    );
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
