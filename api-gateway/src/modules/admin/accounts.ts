import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { REDIS_CHANNELS } from '../../../../shared/constants';
import { env } from '../../config/env';
import { httpError } from '../../utils/httpError';
import { appendHistory } from '../assistant/memory';
import { usagePeriod } from '../assistant/quota';
import { publishSessionsRevoked } from '../auth/sessionEvents';
import { extendPlan, orderView } from '../payments/service';
import { type AdminActor, listAdminActions, recordAdminAction } from './audit';
import { forgetOverview } from './overview';

/**
 * Customers' accounts as staff see them: who they are, their plan, devices
 * and sessions — never their chats, camera, access history or secrets — and
 * the few things staff may change, each with a reason in admin_audit_log.
 *
 * Locking an account (status 'disabled'): every session ends at once and the
 * app is signed out; signing in again answers ACCOUNT_LOCKED. While locked,
 * the account's smart features pause (schedules and automations do not act,
 * see scenes/schedules.ts and automations/firing.ts). Devices keep working:
 * their own buttons, keypads and local safety rules, and the people they are
 * shared with, are not affected.
 */

const MAC = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;

export type AccountFilter = 'all' | 'disabled' | 'paid';

export interface AccountQuery {
    q?: string;
    filter: AccountFilter;
    page: number;
    pageSize: number;
}

function iso(value: unknown): string | null {
    return value ? new Date(value as string).toISOString() : null;
}

/** "50%" typed by staff must match a literal percent sign. */
function likePattern(text: string): string {
    return `%${text.replace(/[\\%_]/g, character => `\\${character}`)}%`;
}

export async function listAccounts(app: FastifyInstance, query: AccountQuery) {
    const where: string[] = [];
    const params: unknown[] = [];
    const q = query.q?.trim();
    if (q) {
        const mac = q.toUpperCase().replace(/-/g, ':');
        if (MAC.test(mac)) {
            params.push(mac);
            where.push(`EXISTS (
                SELECT 1 FROM device_memberships AS membership
                JOIN device_metadata AS device ON device.id = membership.device_id AND device.is_active
                WHERE membership.account_id = account.id AND membership.status = 'active' AND device.mac = $${params.length})`);
        } else {
            params.push(likePattern(q));
            where.push(`(account.email ILIKE $${params.length} OR account.full_name ILIKE $${params.length})`);
        }
    }
    if (query.filter === 'disabled') where.push(`account.status = 'disabled'`);
    if (query.filter === 'paid') {
        where.push(`EXISTS (SELECT 1 FROM account_plans AS paid WHERE paid.account_id = account.id AND paid.expires_at > NOW())`);
    }
    params.push(query.pageSize, (query.page - 1) * query.pageSize);
    // The page is chosen first; its few rows then get their plan, devices and last use.
    const result = await app.pg.query(
        `WITH page AS (
            SELECT account.id, account.email, account.full_name, account.status, account.created_at,
                   count(*) OVER () AS total
            FROM accounts AS account
            ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
            ORDER BY account.created_at DESC, account.id DESC
            LIMIT $${params.length - 1} OFFSET $${params.length}
         )
         SELECT page.*, plan.code AS plan_code, plan.name AS plan_name, paid.expires_at AS plan_expires_at,
                (SELECT count(*)::int FROM device_metadata AS device
                 WHERE device.owner_id = page.id AND device.is_active) AS owned_devices,
                (SELECT max(COALESCE(session.last_used_at, session.created_at)) FROM user_sessions AS session
                 WHERE session.account_id = page.id) AS last_seen_at
         FROM page
         LEFT JOIN account_plans AS paid ON paid.account_id = page.id AND paid.expires_at > NOW()
         JOIN assistant_plans AS plan ON plan.code = COALESCE(paid.plan_code, 'free')
         ORDER BY page.created_at DESC, page.id DESC`,
        params,
    );
    return {
        items: result.rows.map(row => ({
            id: row.id as string,
            email: row.email as string,
            full_name: row.full_name as string,
            status: row.status as string,
            created_at: iso(row.created_at),
            plan: { code: row.plan_code as string, name: row.plan_name as string, expires_at: iso(row.plan_expires_at) },
            owned_devices: Number(row.owned_devices),
            last_seen_at: iso(row.last_seen_at),
        })),
        total: Number(result.rows[0]?.total ?? 0),
        page: query.page,
        page_size: query.pageSize,
    };
}

async function loadAccount(app: FastifyInstance, accountId: string) {
    const result = await app.pg.query(
        'SELECT id, email, full_name, status, created_at, updated_at FROM accounts WHERE id = $1',
        [accountId],
    );
    const account = result.rows[0];
    if (!account) throw httpError(404, 'ACCOUNT_NOT_FOUND', 'Không tìm thấy tài khoản.');
    return account;
}

export async function accountDetail(app: FastifyInstance, accountId: string) {
    const account = await loadAccount(app, accountId);
    const { period } = usagePeriod();
    const [plan, usage, devices, sessions, orders, smart, log] = await Promise.all([
        app.pg.query(
            `SELECT plan.code, plan.name, plan.monthly_tokens, paid.expires_at
             FROM assistant_plans AS plan
             LEFT JOIN account_plans AS paid ON paid.account_id = $1 AND paid.plan_code = plan.code AND paid.expires_at > NOW()
             WHERE plan.code = COALESCE(
                 (SELECT plan_code FROM account_plans WHERE account_id = $1 AND expires_at > NOW()), 'free')`,
            [accountId],
        ),
        app.pg.query('SELECT tokens, requests FROM assistant_usage WHERE account_id = $1 AND period = $2', [accountId, period]),
        app.pg.query(
            `SELECT device.mac, device.name, device.product_id, membership.role, membership.created_at
             FROM device_memberships AS membership
             JOIN device_metadata AS device ON device.id = membership.device_id AND device.is_active
             WHERE membership.account_id = $1 AND membership.status = 'active'
             ORDER BY membership.role = 'owner' DESC, device.name
             LIMIT 200`,
            [accountId],
        ),
        app.pg.query(
            `SELECT id, client_platform, client_name, created_at, last_used_at, expires_at
             FROM user_sessions
             WHERE account_id = $1 AND status = 'active' AND expires_at > NOW()
             ORDER BY COALESCE(last_used_at, created_at) DESC
             LIMIT 20`,
            [accountId],
        ),
        app.pg.query(
            `SELECT o.id, o.code, o.account_id, o.plan_code, p.name AS plan_name, o.months, o.amount_vnd, o.status,
                    o.expires_at, o.received_vnd, o.paid_at, o.paid_via, o.plan_expires_at, o.created_at
             FROM payment_orders AS o JOIN assistant_plans AS p ON p.code = o.plan_code
             WHERE o.account_id = $1 ORDER BY o.created_at DESC LIMIT 10`,
            [accountId],
        ),
        app.pg.query(
            `SELECT (SELECT count(*)::int FROM scenes WHERE account_id = $1) AS scenes,
                    (SELECT count(*)::int FROM scene_schedules WHERE account_id = $1 AND enabled) AS schedules,
                    (SELECT count(*)::int FROM automations WHERE account_id = $1 AND enabled) AS automations`,
            [accountId],
        ),
        listAdminActions(app.pg, { page: 1, pageSize: 20, accountId }),
    ]);
    const macs = devices.rows.map(row => row.mac as string);
    const shadows = macs.length === 0 ? [] : await app.mongo.db.collection<any>(env.MONGO_DEVICE_SHADOWS_COLLECTION)
        .find({ _id: { $in: macs } }, { projection: { is_online: 1, last_seen: 1 } })
        .toArray();
    const presence = new Map(shadows.map(shadow => [String(shadow._id), shadow]));
    const current = plan.rows[0];
    return {
        account: {
            id: account.id as string,
            email: account.email as string,
            full_name: account.full_name as string,
            status: account.status as string,
            created_at: iso(account.created_at),
            updated_at: iso(account.updated_at),
        },
        plan: {
            code: current.code as string,
            name: current.name as string,
            monthly_tokens: Number(current.monthly_tokens),
            expires_at: iso(current.expires_at),
            used_tokens: Number(usage.rows[0]?.tokens ?? 0),
            requests: Number(usage.rows[0]?.requests ?? 0),
        },
        smart_features: smart.rows[0] as { scenes: number; schedules: number; automations: number },
        devices: devices.rows.map(row => ({
            mac: row.mac as string,
            name: row.name as string,
            product: String((app.catalog.getProduct(row.product_id) as any)?.presentation?.display_name || row.product_id),
            role: row.role as string,
            since: iso(row.created_at),
            online: presence.get(row.mac)?.is_online === true,
            last_seen: iso(presence.get(row.mac)?.last_seen),
        })),
        sessions: sessions.rows.map(row => ({
            id: row.id as string,
            platform: row.client_platform as string,
            name: row.client_name as string | null,
            created_at: iso(row.created_at),
            last_used_at: iso(row.last_used_at ?? row.created_at),
            expires_at: iso(row.expires_at),
        })),
        orders: orders.rows.map(row => {
            const view = orderView(row);
            return {
                code: view.code, plan: view.plan, months: view.months, amount_vnd: view.amount_vnd,
                received_vnd: view.received_vnd, status: view.status, paid_via: view.paid_via,
                created_at: view.created_at, paid_at: view.paid_at,
            };
        }),
        admin_log: log.items,
    };
}

async function inTransaction<T>(app: FastifyInstance, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await app.pg.connect();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function lockAccount(client: PoolClient, accountId: string) {
    const result = await client.query('SELECT id, email, status FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
    if (!result.rows[0]) throw httpError(404, 'ACCOUNT_NOT_FOUND', 'Không tìm thấy tài khoản.');
    return result.rows[0] as { id: string; email: string; status: string };
}

async function endSessions(client: PoolClient, accountId: string): Promise<number> {
    const revoked = await client.query(
        `UPDATE user_sessions SET status = 'revoked' WHERE account_id = $1 AND status = 'active' RETURNING id`,
        [accountId],
    );
    return revoked.rows.length;
}

/** Locks the account: sessions end now, smart features pause, devices keep working. */
export async function disableAccount(app: FastifyInstance, accountId: string, reason: string, by: AdminActor) {
    const signedOut = await inTransaction(app, async (client) => {
        const account = await lockAccount(client, accountId);
        if (account.status !== 'active') {
            throw httpError(409, 'ACCOUNT_NOT_ACTIVE', 'Tài khoản không ở trạng thái hoạt động.');
        }
        await client.query(`UPDATE accounts SET status = 'disabled' WHERE id = $1`, [accountId]);
        const count = await endSessions(client, accountId);
        await recordAdminAction(client, {
            actor: by, action: 'account.disabled', targetAccountId: accountId, targetEmail: account.email,
            reason, details: { signed_out_sessions: count },
        });
        return count;
    });
    await publishSessionsRevoked(app, accountId, 'all');
    await forgetOverview(app);
    return { status: 'disabled', signed_out_sessions: signedOut };
}

/** Unlocks: the customer signs in again; schedules and automations act again from their next occurrence. */
export async function enableAccount(app: FastifyInstance, accountId: string, reason: string, by: AdminActor) {
    await inTransaction(app, async (client) => {
        const account = await lockAccount(client, accountId);
        if (account.status !== 'disabled') throw httpError(409, 'ACCOUNT_NOT_DISABLED', 'Tài khoản không bị khóa.');
        await client.query(`UPDATE accounts SET status = 'active' WHERE id = $1`, [accountId]);
        await recordAdminAction(client, {
            actor: by, action: 'account.enabled', targetAccountId: accountId, targetEmail: account.email, reason,
        });
    });
    await forgetOverview(app);
    return { status: 'active' };
}

/** Signs the account out of every phone and computer (for example after a suspected leak). */
export async function signOutAccount(app: FastifyInstance, accountId: string, reason: string, by: AdminActor) {
    const signedOut = await inTransaction(app, async (client) => {
        const account = await lockAccount(client, accountId);
        const count = await endSessions(client, accountId);
        await recordAdminAction(client, {
            actor: by, action: 'account.signed_out', targetAccountId: accountId, targetEmail: account.email,
            reason, details: { signed_out_sessions: count },
        });
        return count;
    });
    await publishSessionsRevoked(app, accountId, 'all');
    return { signed_out_sessions: signedOut };
}

function vietnamDate(value: Date): string {
    return new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' })
        .format(value);
}

/**
 * Gives [days] of a paid plan (compensation, a promotion): the same rules as a
 * purchase (the same plan continues from its end; another plan starts now and
 * converts the remaining time). No order or revenue is recorded; the log is.
 */
export async function giftPlan(
    app: FastifyInstance,
    accountId: string,
    input: { plan_code: string; days: number; reason: string },
    by: AdminActor,
) {
    const plan = (await app.pg.query(
        'SELECT code, name FROM assistant_plans WHERE code = $1 AND is_active AND price_vnd > 0',
        [input.plan_code],
    )).rows[0];
    if (!plan) throw httpError(400, 'PLAN_NOT_GIFTABLE', 'Chỉ tặng được gói trả phí đang bán.');
    const result = await inTransaction(app, async (client) => {
        const account = await lockAccount(client, accountId);
        if (account.status === 'pending_deletion') throw httpError(409, 'ACCOUNT_NOT_ACTIVE', 'Tài khoản đang chờ xóa.');
        const before = (await client.query(
            'SELECT plan_code, expires_at FROM account_plans WHERE account_id = $1 AND expires_at > NOW()',
            [accountId],
        )).rows[0];
        const expiresAt = await extendPlan(client, accountId, plan.code, { days: input.days });
        await recordAdminAction(client, {
            actor: by, action: 'plan.gifted', targetAccountId: accountId, targetEmail: account.email,
            reason: input.reason,
            details: {
                plan_code: plan.code, plan_name: plan.name, days: input.days, expires_at: expiresAt.toISOString(),
                before: before ? { plan_code: before.plan_code, expires_at: iso(before.expires_at) } : null,
            },
        });
        return expiresAt;
    });
    const gift = { plan: { code: plan.code as string, name: plan.name as string }, days: input.days, expires_at: result.toISOString() };
    try {
        await app.redis.publish(REDIS_CHANNELS.ACCOUNT_EVENT, JSON.stringify({
            account_id: accountId, event: 'plan_gifted', data: gift,
        }));
    } catch (error) {
        app.log.warn({ error }, 'Failed to announce a gifted plan');
    }
    // A chat right after the gift knows the plan changed.
    await appendHistory(app, accountId, [{
        role: 'model', text: `Bạn được tặng ${input.days} ngày gói ${plan.name}; gói có hiệu lực đến ${vietnamDate(result)}.`,
    }]).catch(error => app.log.warn({ error }, 'Failed to note a gifted plan in the assistant history'));
    await forgetOverview(app);
    return gift;
}
