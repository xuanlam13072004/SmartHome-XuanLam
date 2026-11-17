import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { REDIS_CHANNELS } from '../../../../shared/constants';
import { env } from '../../config/env';

/**
 * Notifications addressed to one account (an automation's "gửi thông báo"),
 * kept in PostgreSQL next to the device events the notification center reads
 * from MongoDB. They are never muted: the account chose to receive them.
 */

export interface AccountNotificationRow {
    id: string;
    automation_id: string | null;
    title: string;
    body: string;
    created_at: Date;
}

export interface AccountNotificationItem {
    id: string;
    kind: 'automation';
    at: string;
    occurred_at: string;
    title: string;
    body: string;
    automation_id: string | null;
    severity: 'info';
    category: 'automation';
    unread: boolean;
}

const COLUMNS = 'id, automation_id, title, body, created_at';

export function notificationItem(row: AccountNotificationRow, seenAt: Date | null): AccountNotificationItem {
    const at = new Date(row.created_at);
    return {
        id: row.id,
        kind: 'automation',
        at: at.toISOString(),
        occurred_at: at.toISOString(),
        title: row.title,
        body: row.body,
        automation_id: row.automation_id,
        severity: 'info',
        category: 'automation',
        unread: !seenAt || at > seenAt,
    };
}

export async function insertAccountNotification(
    client: PoolClient,
    input: { accountId: string; automationId: string | null; title: string; body: string },
): Promise<AccountNotificationRow> {
    const result = await client.query(
        `INSERT INTO account_notifications (account_id, automation_id, title, body)
         VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
        [input.accountId, input.automationId, input.title, input.body],
    );
    return result.rows[0];
}

/** Newest first, after a merged-list cursor (time desc, device events before these, id desc). */
export async function listAccountNotifications(
    db: Pool,
    accountId: string,
    options: { limit: number; before?: { at: Date; kind: 'event' | 'account'; id: string } },
): Promise<AccountNotificationRow[]> {
    const before = options.before;
    const result = await db.query(
        `SELECT ${COLUMNS} FROM account_notifications
         WHERE account_id = $1
           AND ($2::timestamptz IS NULL OR created_at < $2
                OR (created_at = $2 AND ($3::text = 'event' OR id < $4::uuid)))
         ORDER BY created_at DESC, id DESC
         LIMIT $5`,
        [
            accountId,
            before?.at ?? null,
            before?.kind ?? null,
            before && before.kind === 'account' ? before.id : null,
            options.limit,
        ],
    );
    return result.rows;
}

export async function countAccountNotifications(db: Pool, accountId: string, after: Date | null, cap: number) {
    const result = await db.query(
        `SELECT count(*)::int AS count FROM (
             SELECT 1 FROM account_notifications
             WHERE account_id = $1 AND ($2::timestamptz IS NULL OR created_at > $2)
             LIMIT $3
         ) AS unread`,
        [accountId, after, cap],
    );
    return result.rows[0].count as number;
}

/** Tells the account's open apps (event `notification_created`); best effort. */
export async function publishAccountNotification(app: FastifyInstance, accountId: string, row: AccountNotificationRow) {
    try {
        await app.redis.publish(REDIS_CHANNELS.ACCOUNT_EVENT, JSON.stringify({
            account_id: accountId,
            event: 'notification_created',
            data: { notification: notificationItem(row, null) },
        }));
    } catch (error) {
        app.log.warn({ error }, 'Failed to publish an account notification');
    }
}

export async function purgeOldAccountNotifications(app: FastifyInstance): Promise<number> {
    const result = await app.pg.query(
        `DELETE FROM account_notifications WHERE id IN (
             SELECT id FROM account_notifications
             WHERE created_at < NOW() - make_interval(days => $1)
             LIMIT 5000
         )`,
        [env.ACCOUNT_NOTIFICATION_RETENTION_DAYS],
    );
    return result.rowCount ?? 0;
}
