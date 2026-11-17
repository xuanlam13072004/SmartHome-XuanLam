import type { FastifyInstance } from 'fastify';
import { REDIS_CHANNELS } from '../../../../shared/constants';
import { dispatchDeviceShadowOutboxEvent } from '../../workers/deviceShadowOutboxDispatcher';
import { revokeMediaSessions } from '../device/mediaSessions';
import type { Queryable } from '../activity/audit';

export interface AccessGrant {
    account_id: string;
    role: 'owner' | 'controller' | 'viewer';
    permissions: string[];
}

/** One device whose audience changed; produced inside the transaction, published after commit. */
export interface AccessChange {
    mac: string;
    outboxId: number;
    accessAccountIds: string[];
    removedAccountIds: string[];
    revokedResourceSessionIds: string[];
}

interface CatalogReader {
    getProduct: (productId: string) => { permissions?: string[] } | null;
}

/**
 * Recomputes who may see a device from PostgreSQL (the authority) and queues
 * that projection for the device shadow. Call inside the transaction that
 * changed the memberships. Open camera sessions of removed accounts on this
 * device are revoked in the same transaction.
 */
export async function queueAccessProjection(
    db: Queryable,
    catalog: CatalogReader,
    deviceId: string,
    removedAccountIds: string[] = [],
): Promise<AccessChange> {
    const result = await db.query(
        `SELECT device.mac, device.owner_id, device.product_id,
                membership.account_id, membership.role,
                COALESCE(
                    ARRAY_AGG(permission.permission_scope ORDER BY permission.permission_scope)
                        FILTER (WHERE permission.permission_scope IS NOT NULL),
                    ARRAY[]::text[]
                ) AS permissions
         FROM device_metadata AS device
         JOIN device_memberships AS membership
           ON membership.device_id = device.id
          AND membership.status = 'active'
          AND (membership.expires_at IS NULL OR membership.expires_at > NOW())
         LEFT JOIN device_membership_permissions AS permission
           ON permission.device_id = membership.device_id
          AND permission.account_id = membership.account_id
         WHERE device.id = $1
         GROUP BY device.mac, device.owner_id, device.product_id, membership.account_id, membership.role
         ORDER BY membership.role = 'owner' DESC, membership.account_id`,
        [deviceId],
    );
    if (result.rows.length === 0) throw new Error(`Device ${deviceId} has no active owner membership`);

    const { mac, owner_id: ownerId, product_id: productId } = result.rows[0];
    const ownerPermissions = catalog.getProduct(productId)?.permissions ?? [];
    const grants: AccessGrant[] = result.rows.map(row => (
        row.account_id === ownerId
            ? { account_id: row.account_id, role: 'owner', permissions: ownerPermissions }
            : { account_id: row.account_id, role: row.role, permissions: row.permissions }
    ));

    const revoked = removedAccountIds.length === 0
        ? []
        : (await db.query(
            `UPDATE device_resource_sessions
             SET status = 'revoked', reason_code = 'ACCESS_REVOKED'
             WHERE device_id = $1
               AND actor_account_id = ANY($2::uuid[])
               AND status IN ('requested', 'ready')
             RETURNING id`,
            [deviceId, removedAccountIds],
        )).rows.map(row => row.id as string);

    const outbox = await db.query(
        `INSERT INTO device_shadow_outbox (device_id, mac, operation, payload)
         VALUES ($1, $2, 'access', $3::jsonb)
         RETURNING id`,
        [deviceId, mac, JSON.stringify({ owner_id: ownerId, access_grants: grants })],
    );

    return {
        mac,
        outboxId: Number(outbox.rows[0].id),
        accessAccountIds: grants.map(grant => grant.account_id),
        removedAccountIds,
        revokedResourceSessionIds: revoked,
    };
}

/**
 * After commit: update the shadow projection, drop camera viewers that lost
 * access and tell the realtime service so it re-routes live updates at once.
 * Failures are retried by the background outbox dispatcher.
 */
export async function publishAccessChanges(app: FastifyInstance, changes: AccessChange[]): Promise<void> {
    for (const change of changes) {
        try {
            await dispatchDeviceShadowOutboxEvent(app.pg, app.mongo.db, app.log, change.outboxId);
        } catch (error) {
            app.log.warn({ error, mac: change.mac }, 'Device access projection queued for retry');
        }
        try {
            await revokeMediaSessions(app.redis, change.mac, change.revokedResourceSessionIds);
            await app.redis.publish(REDIS_CHANNELS.DEVICE_ACCESS_CHANGED, JSON.stringify({
                mac: change.mac,
                access_account_ids: change.accessAccountIds,
                removed_account_ids: change.removedAccountIds,
            }));
        } catch (error) {
            app.log.warn({ error, mac: change.mac }, 'Failed to announce a device access change');
        }
    }
}
