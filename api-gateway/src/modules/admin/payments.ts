import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { env } from '../../config/env';
import { cancelOrderByStaff, confirmOrderManually, orderView, sepayTransactionsThisMonth, type StaffAudit } from '../payments/service';
import { type AdminActor, recordAdminAction } from './audit';
import { forgetOverview } from './overview';

/**
 * "Thanh toán": orders to look at and bank transfers no order matched, with
 * the two corrections staff may make (the same functions the CLI uses).
 */

export const PAYMENT_TABS = ['review', 'pending', 'paid', 'unmatched'] as const;
export type PaymentTab = typeof PAYMENT_TABS[number];

const ORDER_SELECT = `SELECT o.id, o.code, o.account_id, o.plan_code, p.name AS plan_name, o.months, o.amount_vnd, o.status,
        o.expires_at, o.received_vnd, o.paid_at, o.paid_via, o.plan_expires_at, o.created_at,
        a.email, count(*) OVER () AS total
    FROM payment_orders AS o
    JOIN assistant_plans AS p ON p.code = o.plan_code
    JOIN accounts AS a ON a.id = o.account_id`;

const ORDER_TABS: Record<Exclude<PaymentTab, 'unmatched'>, string> = {
    // Part paid: the customer sent less than the price.
    review: `WHERE o.status = 'review' ORDER BY o.created_at DESC`,
    // Waiting for a transfer (a late one still pays an expired QR), last 7 days.
    pending: `WHERE o.status = 'pending' AND o.created_at > NOW() - interval '7 days' ORDER BY o.created_at DESC`,
    paid: `WHERE o.status = 'paid' ORDER BY o.paid_at DESC`,
};

function adminOrder(row: any) {
    const view = orderView(row);
    return {
        code: view.code,
        account: { id: row.account_id as string, email: row.email as string },
        plan: view.plan,
        months: view.months,
        amount_vnd: view.amount_vnd,
        received_vnd: view.received_vnd,
        status: view.status,
        paid_via: view.paid_via,
        created_at: view.created_at,
        expires_at: view.expires_at,
        paid_at: view.paid_at,
        plan_expires_at: view.plan_expires_at,
    };
}

export async function listPayments(app: FastifyInstance, query: { tab: PaymentTab; page: number; pageSize: number }) {
    const offset = (query.page - 1) * query.pageSize;
    const [summary, sepay, list] = await Promise.all([
        app.pg.query(
            `SELECT (SELECT count(*)::int FROM payment_orders WHERE status = 'review') AS review,
                    (SELECT count(*)::int FROM payment_orders
                     WHERE status = 'pending' AND created_at > NOW() - interval '7 days') AS pending,
                    (SELECT count(*)::int FROM payment_transactions
                     WHERE outcome IN ('unmatched', 'already_paid') AND received_at > NOW() - interval '30 days') AS unmatched`,
        ),
        sepayTransactionsThisMonth(app.pg),
        query.tab === 'unmatched'
            ? app.pg.query(
                `SELECT t.id, t.provider, t.provider_ref, t.amount_vnd, t.content, t.transferred_at, t.received_at, t.outcome,
                        o.code AS order_code, count(*) OVER () AS total
                 FROM payment_transactions AS t
                 LEFT JOIN payment_orders AS o ON o.id = t.order_id
                 WHERE t.outcome IN ('unmatched', 'already_paid') AND t.received_at > NOW() - interval '30 days'
                 ORDER BY t.received_at DESC
                 LIMIT $1 OFFSET $2`,
                [query.pageSize, offset],
            )
            : app.pg.query(`${ORDER_SELECT} ${ORDER_TABS[query.tab]} LIMIT $1 OFFSET $2`, [query.pageSize, offset]),
    ]);
    return {
        mode: env.PAYMENT_MODE,
        counts: summary.rows[0] as { review: number; pending: number; unmatched: number },
        sepay: { used: sepay, limit: env.SEPAY_MONTHLY_LIMIT },
        tab: query.tab,
        items: query.tab === 'unmatched'
            ? list.rows.map(row => ({
                id: row.id as string,
                provider: row.provider as string,
                reference: row.provider_ref as string,
                amount_vnd: Number(row.amount_vnd),
                content: row.content as string,
                outcome: row.outcome as string,
                order_code: row.order_code as string | null,
                transferred_at: row.transferred_at ? new Date(row.transferred_at).toISOString() : null,
                received_at: new Date(row.received_at).toISOString(),
            }))
            : list.rows.map(adminOrder),
        total: Number(list.rows[0]?.total ?? 0),
        page: query.page,
        page_size: query.pageSize,
    };
}

/** What the log keeps of a correction made to [order] by staff. */
export function auditOrder(actor: AdminActor, action: 'payment.confirmed' | 'payment.cancelled', reason: string, amount?: number): StaffAudit {
    return async (client: PoolClient, order: any, outcome: string) => {
        const email = (await client.query('SELECT email FROM accounts WHERE id = $1', [order.account_id])).rows[0]?.email ?? null;
        await recordAdminAction(client, {
            actor, action, targetAccountId: order.account_id, targetEmail: email, reason,
            details: {
                code: order.code,
                outcome,
                ...(action === 'payment.confirmed'
                    ? { amount_vnd: amount ?? Number(order.amount_vnd) - Number(order.received_vnd) }
                    : {}),
            },
        });
    };
}

function deps(app: FastifyInstance) {
    return { pg: app.pg, redis: app.redis, log: app.log };
}

/** Records a transfer seen in the bank app; [amount] defaults to what is still owed. */
export async function confirmPayment(
    app: FastifyInstance,
    code: string,
    input: { amount_vnd?: number; reason: string },
    actor: AdminActor = 'admin',
) {
    const result = await confirmOrderManually(
        deps(app), code, input.amount_vnd, auditOrder(actor, 'payment.confirmed', input.reason, input.amount_vnd),
    );
    await forgetOverview(app);
    return { outcome: result.outcome, order: result.order };
}

export async function cancelPayment(app: FastifyInstance, code: string, reason: string, actor: AdminActor = 'admin') {
    const order = await cancelOrderByStaff(deps(app), code, auditOrder(actor, 'payment.cancelled', reason));
    await forgetOverview(app);
    return { order };
}
