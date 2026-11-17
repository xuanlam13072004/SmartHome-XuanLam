import { ObjectId } from 'mongodb';
import type { FastifyInstance } from 'fastify';
import { notificationCategory } from '../../../../shared/notification-categories';
import { env } from '../../config/env';
import { httpError } from '../../utils/httpError';
import {
    countAccountNotifications,
    listAccountNotifications,
    notificationItem,
} from './accountNotifications';
import { buildNotificationFilter, VisibleDevice } from './filter';

/** Badge counts stop here; the app shows "99+". */
const BADGE_CAP = 100;

interface Preferences {
    muted_categories: string[];
    notifications_seen_at: Date | null;
}

async function readPreferences(app: FastifyInstance, accountId: string): Promise<Preferences> {
    const result = await app.pg.query(
        `SELECT muted_notification_categories, notifications_seen_at
         FROM account_preferences WHERE account_id = $1`,
        [accountId],
    );
    const row = result.rows[0];
    return {
        muted_categories: row?.muted_notification_categories ?? [],
        notifications_seen_at: row?.notifications_seen_at ?? null,
    };
}

async function visibleDevices(app: FastifyInstance, accountId: string): Promise<VisibleDevice[]> {
    const result = await app.pg.query(
        `SELECT device.mac, device.name, membership.role = 'owner' AS owner, membership.created_at AS joined_at
         FROM device_memberships AS membership
         JOIN device_metadata AS device ON device.id = membership.device_id AND device.is_active = true
         WHERE membership.account_id = $1 AND membership.status = 'active'
           AND (membership.expires_at IS NULL OR membership.expires_at > NOW())
         LIMIT 500`,
        [accountId],
    );
    return result.rows.map(row => ({ mac: row.mac, name: row.name, owner: row.owner, joined_at: new Date(row.joined_at) }));
}

function events(app: FastifyInstance) {
    return app.mongo.db.collection(env.MONGO_DEVICE_EVENTS_COLLECTION);
}

/**
 * The notification center merges device events (MongoDB) and account
 * notifications (PostgreSQL). Order: time desc, then device events before
 * account notifications, then id desc; the cursor is the last item shown.
 */
type CursorKind = 'event' | 'account';

interface Cursor {
    at: Date;
    kind: CursorKind;
    id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function encodeCursor(cursor: Cursor): string {
    return Buffer.from(JSON.stringify({ t: cursor.at.toISOString(), k: cursor.kind, i: cursor.id })).toString('base64url');
}

function decodeCursor(value: string): Cursor {
    try {
        const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
        const at = new Date(cursor.t);
        const kind: CursorKind = cursor.k === 'account' ? 'account' : 'event';
        const id = String(cursor.i);
        const valid = kind === 'event' ? ObjectId.isValid(id) : UUID.test(id);
        if (!Number.isNaN(at.getTime()) && valid) return { at, kind, id };
    } catch {
        // fall through
    }
    throw httpError(400, 'INVALID_CURSOR', 'Invalid page cursor');
}

function newestFirst(a: Cursor, b: Cursor): number {
    if (a.at.getTime() !== b.at.getTime()) return b.at.getTime() - a.at.getTime();
    if (a.kind !== b.kind) return a.kind === 'event' ? -1 : 1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export async function getPreferences(app: FastifyInstance, accountId: string) {
    const preferences = await readPreferences(app, accountId);
    return { muted_notification_categories: preferences.muted_categories };
}

export async function updatePreferences(app: FastifyInstance, accountId: string, muted: string[]) {
    const result = await app.pg.query(
        `INSERT INTO account_preferences (account_id, muted_notification_categories)
         VALUES ($1, $2::text[])
         ON CONFLICT (account_id) DO UPDATE SET muted_notification_categories = EXCLUDED.muted_notification_categories
         RETURNING muted_notification_categories`,
        [accountId, [...new Set(muted)].sort()],
    );
    return { muted_notification_categories: result.rows[0].muted_notification_categories };
}

/** Everything up to now counts as read. */
export async function markNotificationsSeen(app: FastifyInstance, accountId: string) {
    await app.pg.query(
        `INSERT INTO account_preferences (account_id, notifications_seen_at)
         VALUES ($1, NOW())
         ON CONFLICT (account_id) DO UPDATE SET notifications_seen_at = NOW()`,
        [accountId],
    );
}

/** "Thông báo": newest first, keyset pages of `limit`. */
export async function listNotifications(
    app: FastifyInstance,
    accountId: string,
    options: { before?: string; limit: number },
) {
    const cursor = options.before ? decodeCursor(options.before) : undefined;
    const [devices, preferences] = await Promise.all([visibleDevices(app, accountId), readPreferences(app, accountId)]);
    const filter = buildNotificationFilter({
        devices,
        muted: preferences.muted_categories,
        before: cursor ? { at: cursor.at, id: cursor.kind === 'event' ? new ObjectId(cursor.id) : null } : undefined,
    });
    const [docs, notices] = await Promise.all([
        filter
            ? events(app)
                .find(filter, {
                    projection: {
                        device_id: 1, capability_id: 1, instance_id: 1, event_name: 1,
                        severity: 1, data: 1, occurred_at: 1, received_at: 1,
                    },
                })
                .sort({ received_at: -1, _id: -1 })
                .limit(options.limit + 1)
                .toArray()
            : Promise.resolve([] as any[]),
        listAccountNotifications(app.pg, accountId, { limit: options.limit + 1, before: cursor }),
    ]);

    const names = new Map(devices.map(device => [device.mac, device.name]));
    const seenAt = preferences.notifications_seen_at;
    const merged = [
        ...docs.map(doc => {
            const receivedAt = new Date(doc.received_at);
            return {
                cursor: { at: receivedAt, kind: 'event' as const, id: String(doc._id) },
                item: {
                    id: String(doc._id),
                    kind: 'device_event' as const,
                    at: receivedAt.toISOString(),
                    occurred_at: new Date(doc.occurred_at ?? doc.received_at).toISOString(),
                    device: { mac: doc.device_id, name: names.get(doc.device_id) ?? doc.device_id },
                    capability_id: doc.capability_id,
                    instance_id: doc.instance_id,
                    event_name: doc.event_name,
                    severity: doc.severity,
                    category: notificationCategory(doc.capability_id),
                    data: doc.data ?? {},
                    unread: !seenAt || receivedAt > seenAt,
                },
            };
        }),
        ...notices.map(row => ({
            cursor: { at: new Date(row.created_at), kind: 'account' as const, id: row.id },
            item: notificationItem(row, seenAt),
        })),
    ].sort((a, b) => newestFirst(a.cursor, b.cursor));

    const page = merged.slice(0, options.limit);
    const last = page[page.length - 1];
    return {
        items: page.map(entry => entry.item),
        next_cursor: merged.length > options.limit && last ? encodeCursor(last.cursor) : null,
    };
}

/** Red dots of the "Cá nhân" tab: unread notifications and pending invitations. */
export async function getBadges(app: FastifyInstance, accountId: string) {
    const [devices, preferences, invites] = await Promise.all([
        visibleDevices(app, accountId),
        readPreferences(app, accountId),
        app.pg.query(
            `SELECT count(*)::int AS count
             FROM device_invites AS invite
             JOIN accounts AS account ON account.id = $1
             WHERE lower(invite.invited_email) = account.email
               AND invite.status = 'pending' AND invite.expires_at > NOW()`,
            [accountId],
        ),
    ]);
    const filter = buildNotificationFilter({
        devices,
        muted: preferences.muted_categories,
        after: preferences.notifications_seen_at,
    });
    const [deviceEvents, accountNotifications] = await Promise.all([
        filter ? events(app).countDocuments(filter, { limit: BADGE_CAP }) : 0,
        countAccountNotifications(app.pg, accountId, preferences.notifications_seen_at, BADGE_CAP),
    ]);
    return {
        notifications: Math.min(BADGE_CAP, deviceEvents + accountNotifications),
        invites: invites.rows[0].count,
    };
}
