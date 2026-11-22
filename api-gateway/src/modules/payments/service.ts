import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { REDIS_CHANNELS } from '../../../../shared/constants';
import { env } from '../../config/env';
import { httpError } from '../../utils/httpError';
import { buildVietQr, findOrderCode, isOrderCode, newOrderCode } from './vietqr';

/**
 * Buying an assistant plan (docs/architecture/payments.md): the server prices
 * an order, the user transfers by VietQR with the order code in the note, and
 * the transfer is matched by the SePay webhook, confirmed by hand (CLI), or
 * simulated in mock mode. Full payment extends `account_plans`.
 */

/** What payments need from the app; the CLI passes the same without Fastify. */
export interface PaymentDeps {
    pg: Pool;
    redis: FastifyInstance['redis'] | null;
    log: { info(obj: unknown, msg?: string): void; warn(obj: unknown, msg?: string): void };
}

type Via = 'sepay' | 'manual' | 'mock';

const ORDER_COLUMNS = `o.id, o.code, o.account_id, o.plan_code, p.name AS plan_name, o.months, o.amount_vnd, o.status,
    o.expires_at, o.received_vnd, o.paid_at, o.paid_via, o.plan_expires_at, o.created_at`;

export function bankConfigured(): boolean {
    return Boolean(env.PAYMENT_BANK_BIN && env.PAYMENT_BANK_ACCOUNT);
}

function paymentsAvailable(): boolean {
    return env.PAYMENT_MODE === 'mock' || (env.PAYMENT_MODE === 'bank' && bankConfigured());
}

function iso(value: Date | string | null): string | null {
    return value ? new Date(value).toISOString() : null;
}

export function orderView(row: any) {
    const expired = row.status === 'pending' && new Date(row.expires_at).getTime() <= Date.now();
    const remaining = Math.max(0, Number(row.amount_vnd) - Number(row.received_vnd));
    const open = (row.status === 'pending' && !expired) || row.status === 'review';
    return {
        code: row.code as string,
        plan: { code: row.plan_code as string, name: row.plan_name as string },
        months: Number(row.months),
        amount_vnd: Number(row.amount_vnd),
        received_vnd: Number(row.received_vnd),
        /** pending · expired · review (part paid) · paid · cancelled */
        status: expired ? 'expired' : row.status as string,
        expires_at: iso(row.expires_at),
        created_at: iso(row.created_at),
        paid_at: iso(row.paid_at),
        paid_via: row.paid_via as string | null,
        plan_expires_at: iso(row.plan_expires_at),
        mock: env.PAYMENT_MODE === 'mock',
        transfer: open && env.PAYMENT_MODE === 'bank' && bankConfigured() && remaining > 0 ? {
            bank_name: env.PAYMENT_BANK_NAME || null,
            bank_bin: env.PAYMENT_BANK_BIN,
            account_number: env.PAYMENT_BANK_ACCOUNT,
            account_name: env.PAYMENT_ACCOUNT_NAME || null,
            amount_vnd: remaining,
            note: row.code as string,
            qr: buildVietQr({ bin: env.PAYMENT_BANK_BIN, account: env.PAYMENT_BANK_ACCOUNT, amount: remaining, note: row.code }),
        } : null,
    };
}

export type OrderView = ReturnType<typeof orderView>;

async function loadOrder(db: Pool | PoolClient, where: string, params: unknown[], lock = false) {
    const result = await db.query(
        `SELECT ${ORDER_COLUMNS} FROM payment_orders AS o JOIN assistant_plans AS p ON p.code = o.plan_code
         WHERE ${where}${lock ? ' FOR UPDATE OF o' : ''}`,
        params,
    );
    return result.rows[0] ?? null;
}

/** Tells the account's open apps (event `payment_updated`); best effort. */
async function publishOrder(deps: PaymentDeps, row: any) {
    if (!deps.redis) return;
    try {
        await deps.redis.publish(REDIS_CHANNELS.ACCOUNT_EVENT, JSON.stringify({
            account_id: row.account_id,
            event: 'payment_updated',
            data: { order: orderView(row) },
        }));
    } catch (error) {
        deps.log.warn({ error }, 'Failed to publish a payment update');
    }
}

async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
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

// ── Plans and orders ───────────────────────────────────────────────────────

export async function paymentOptions(app: FastifyInstance) {
    const result = await app.pg.query(
        `SELECT code, name, monthly_tokens, price_vnd, price_12m_vnd FROM assistant_plans
         WHERE is_active AND price_vnd > 0 ORDER BY position`,
    );
    return {
        /** off · mock (no real money) · bank (VietQR) */
        mode: env.PAYMENT_MODE,
        available: paymentsAvailable(),
        bank_name: env.PAYMENT_MODE === 'bank' ? env.PAYMENT_BANK_NAME || null : null,
        order_minutes: env.PAYMENT_ORDER_TTL_MINUTES,
        plans: result.rows.map(row => ({
            code: row.code,
            name: row.name,
            monthly_tokens: Number(row.monthly_tokens),
            prices: [
                { months: 1, amount_vnd: Number(row.price_vnd) },
                { months: 12, amount_vnd: Number(row.price_12m_vnd ?? row.price_vnd * 12) },
            ],
        })),
    };
}

/** A new order replaces the account's unpaid one (one QR at a time). */
export async function createOrder(app: FastifyInstance, accountId: string, input: { plan_code: string; months: 1 | 12 }) {
    if (!paymentsAvailable()) throw httpError(503, 'PAYMENT_UNAVAILABLE', 'Thanh toán chưa được bật.');
    const plan = (await app.pg.query(
        'SELECT code, price_vnd, price_12m_vnd FROM assistant_plans WHERE code = $1 AND is_active AND price_vnd > 0',
        [input.plan_code],
    )).rows[0];
    if (!plan) throw httpError(400, 'PAYMENT_PLAN_INVALID', 'Gói này không mua được.');
    const amount = input.months === 12 ? Number(plan.price_12m_vnd ?? plan.price_vnd * 12) : Number(plan.price_vnd);
    const row = await inTransaction(app.pg, async (client) => {
        const account = await client.query(`SELECT 1 FROM accounts WHERE id = $1 AND status = 'active' FOR UPDATE`, [accountId]);
        if (!account.rows[0]) throw httpError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
        await client.query(`UPDATE payment_orders SET status = 'cancelled' WHERE account_id = $1 AND status = 'pending'`, [accountId]);
        for (let attempt = 0; ; attempt += 1) {
            const code = newOrderCode();
            const inserted = await client.query(
                `INSERT INTO payment_orders (code, account_id, plan_code, months, amount_vnd, expires_at)
                 VALUES ($1, $2, $3, $4, $5, NOW() + make_interval(mins => $6))
                 ON CONFLICT (code) DO NOTHING RETURNING id`,
                [code, accountId, plan.code, input.months, amount, env.PAYMENT_ORDER_TTL_MINUTES],
            );
            if (inserted.rows[0]) return loadOrder(client, 'o.id = $1', [inserted.rows[0].id]);
            if (attempt >= 4) throw new Error('Could not allocate an order code');
        }
    });
    return orderView(row);
}

export async function getOrder(app: FastifyInstance, accountId: string, code: string) {
    const row = isOrderCode(code) ? await loadOrder(app.pg, 'o.code = $1 AND o.account_id = $2', [code, accountId]) : null;
    if (!row) throw httpError(404, 'PAYMENT_ORDER_NOT_FOUND', 'Không tìm thấy đơn hàng.');
    return orderView(row);
}

export async function listOrders(app: FastifyInstance, accountId: string) {
    const result = await app.pg.query(
        `SELECT ${ORDER_COLUMNS} FROM payment_orders AS o JOIN assistant_plans AS p ON p.code = o.plan_code
         WHERE o.account_id = $1 AND o.status <> 'cancelled' ORDER BY o.created_at DESC LIMIT 20`,
        [accountId],
    );
    return result.rows.map(orderView);
}

export async function cancelOrder(app: FastifyInstance, accountId: string, code: string) {
    const result = await app.pg.query(
        `UPDATE payment_orders SET status = 'cancelled'
         WHERE code = $1 AND account_id = $2 AND status = 'pending' RETURNING id`,
        [code, accountId],
    );
    if (!result.rows[0]) throw httpError(409, 'PAYMENT_ORDER_NOT_OPEN', 'Đơn hàng không còn chờ thanh toán.');
}

// ── Receiving money ────────────────────────────────────────────────────────

/**
 * Adds [amount] to a locked order. Once the order is fully paid the plan is
 * extended: the same plan continues from its current end; another plan starts
 * now and the unused time of the old one is converted at the two prices.
 * A late transfer (after the QR expired) or one for a replaced order is still
 * honoured: the money arrived.
 */
async function applyPayment(client: PoolClient, order: any, amount: number, via: Via) {
    if (order.status === 'paid') return { outcome: 'already_paid' as const, changed: false };
    const received = Number(order.received_vnd) + amount;
    if (received < Number(order.amount_vnd)) {
        await client.query(`UPDATE payment_orders SET status = 'review', received_vnd = $2 WHERE id = $1`, [order.id, received]);
        return { outcome: 'partial' as const, changed: true };
    }
    const current = (await client.query(
        `SELECT paid.plan_code, paid.expires_at, paid.expires_at > NOW() AS active, plan.price_vnd
         FROM account_plans AS paid JOIN assistant_plans AS plan ON plan.code = paid.plan_code
         WHERE paid.account_id = $1 FOR UPDATE OF paid`,
        [order.account_id],
    )).rows[0];
    const newPrice = Number((await client.query('SELECT price_vnd FROM assistant_plans WHERE code = $1', [order.plan_code])).rows[0].price_vnd);
    const samePlan = current?.active && current.plan_code === order.plan_code;
    const creditSeconds = current?.active && !samePlan && Number(current.price_vnd) > 0 && newPrice > 0
        ? Math.floor(((new Date(current.expires_at).getTime() - Date.now()) / 1000) * Number(current.price_vnd) / newPrice)
        : 0;
    const plan = (await client.query(
        `INSERT INTO account_plans (account_id, plan_code, started_at, expires_at)
         VALUES ($1, $2, NOW(), (CASE WHEN $3::boolean THEN $4::timestamptz ELSE NOW() END)
                 + make_interval(months => $5) + make_interval(secs => $6))
         ON CONFLICT (account_id) DO UPDATE SET
             started_at = CASE WHEN $3::boolean THEN account_plans.started_at ELSE NOW() END,
             plan_code = EXCLUDED.plan_code,
             expires_at = EXCLUDED.expires_at
         RETURNING expires_at`,
        [order.account_id, order.plan_code, Boolean(samePlan), samePlan ? current.expires_at : null, Number(order.months), creditSeconds],
    )).rows[0];
    await client.query(
        `UPDATE payment_orders SET status = 'paid', received_vnd = $2, paid_at = NOW(), paid_via = $3, plan_expires_at = $4
         WHERE id = $1`,
        [order.id, received, via, plan.expires_at],
    );
    return { outcome: 'paid' as const, changed: true };
}

async function settle(deps: PaymentDeps, orderId: string) {
    const row = await loadOrder(deps.pg, 'o.id = $1', [orderId]);
    if (row) {
        await publishOrder(deps, row);
        deps.log.info({ order: row.code, status: row.status, via: row.paid_via }, 'Payment order updated');
    }
    return row ? orderView(row) : null;
}

/** Mock mode only: pays the order as if the transfer had arrived. */
export async function simulatePayment(app: FastifyInstance, accountId: string, code: string) {
    if (env.PAYMENT_MODE !== 'mock') throw httpError(404, 'NOT_FOUND', 'Not found');
    const orderId = await inTransaction(app.pg, async (client) => {
        const order = isOrderCode(code) ? await loadOrder(client, 'o.code = $1 AND o.account_id = $2', [code, accountId], true) : null;
        if (!order || order.status === 'cancelled') throw httpError(404, 'PAYMENT_ORDER_NOT_FOUND', 'Không tìm thấy đơn hàng.');
        await applyPayment(client, order, Number(order.amount_vnd) - Number(order.received_vnd), 'mock');
        return order.id as string;
    });
    return settle(app, orderId);
}

/** Confirmation by hand (CLI): a transfer seen in the bank app that the webhook missed. */
export async function confirmOrderManually(deps: PaymentDeps, code: string, amount?: number) {
    const result = await inTransaction(deps.pg, async (client) => {
        const order = isOrderCode(code) ? await loadOrder(client, 'o.code = $1', [code], true) : null;
        if (!order) throw httpError(404, 'PAYMENT_ORDER_NOT_FOUND', `No order ${code}`);
        const paid = amount ?? Number(order.amount_vnd) - Number(order.received_vnd);
        if (!(paid > 0)) throw httpError(400, 'PAYMENT_AMOUNT_INVALID', 'Nothing left to pay');
        const applied = await applyPayment(client, order, paid, 'manual');
        await client.query(
            `INSERT INTO payment_transactions (provider, provider_ref, amount_vnd, content, order_id, outcome)
             VALUES ('manual', $1, $2, $3, $4, $5)`,
            [`manual:${crypto.randomUUID()}`, paid, code, order.id, applied.outcome],
        );
        return { orderId: order.id as string, outcome: applied.outcome };
    });
    return { outcome: result.outcome, order: await settle(deps, result.orderId) };
}

/** SePay's transactionDate is Vietnam local time ("2026-11-22 11:20:05"). */
function vietnamTime(value: unknown): Date | null {
    const text = String(value ?? '');
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) return null;
    const date = new Date(`${text.replace(' ', 'T')}+07:00`);
    return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * One SePay notification. Stored once (its id), whatever it is; an incoming
 * transfer to our account whose note carries an order code pays that order.
 */
export async function handleSepayTransaction(deps: PaymentDeps, payload: Record<string, any>) {
    const ref = String(payload.id ?? '').slice(0, 100);
    const amount = Number(payload.transferAmount);
    if (!ref || !Number.isFinite(amount)) throw httpError(400, 'PAYMENT_PAYLOAD_INVALID', 'Invalid payload');
    const content = String(payload.content ?? payload.description ?? '').slice(0, 500);
    const accounts = [payload.accountNumber, payload.subAccount].filter(Boolean).map(String);
    const code = isOrderCode(String(payload.code ?? '').toUpperCase())
        ? String(payload.code).toUpperCase() : findOrderCode(content);

    const result = await inTransaction(deps.pg, async (client) => {
        const inserted = await client.query(
            `INSERT INTO payment_transactions (provider, provider_ref, amount_vnd, content, account_number, transferred_at, outcome)
             VALUES ('sepay', $1, $2, $3, $4, $5, 'unmatched')
             ON CONFLICT (provider, provider_ref) DO NOTHING RETURNING id`,
            [ref, Math.round(amount), content, accounts[0]?.slice(0, 40) ?? null, vietnamTime(payload.transactionDate)],
        );
        if (!inserted.rows[0]) return { duplicate: true, orderId: null as string | null, outcome: null as string | null };
        let outcome: string = 'unmatched';
        let orderId: string | null = null;
        if (payload.transferType !== 'in' || amount <= 0) {
            outcome = 'outgoing';
        } else if (env.PAYMENT_BANK_ACCOUNT && !accounts.includes(env.PAYMENT_BANK_ACCOUNT)) {
            outcome = 'other_account';
        } else if (code) {
            const order = await loadOrder(client, 'o.code = $1', [code], true);
            if (order) {
                orderId = order.id;
                outcome = (await applyPayment(client, order, Math.round(amount), 'sepay')).outcome;
            }
        }
        await client.query('UPDATE payment_transactions SET outcome = $2, order_id = $3 WHERE id = $1',
            [inserted.rows[0].id, outcome, orderId]);
        return { duplicate: false, orderId, outcome };
    });
    if (result.duplicate) return { duplicate: true };
    if (result.outcome !== 'paid' && result.outcome !== 'partial') {
        deps.log.warn({ ref, outcome: result.outcome }, 'SePay transaction needs review');
    }
    if (result.orderId) await settle(deps, result.orderId);
    await warnNearQuota(deps);
    return { duplicate: false, outcome: result.outcome };
}

/** SePay FREE allows 50 transactions a month; more are billed. */
export async function sepayTransactionsThisMonth(pg: Pool): Promise<number> {
    const result = await pg.query(
        `SELECT count(*)::int AS count FROM payment_transactions
         WHERE provider = 'sepay'
           AND received_at >= date_trunc('month', NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh'`,
    );
    return result.rows[0].count;
}

async function warnNearQuota(deps: PaymentDeps) {
    const used = await sepayTransactionsThisMonth(deps.pg);
    if (used >= env.SEPAY_MONTHLY_LIMIT - 5) {
        deps.log.warn({ used, limit: env.SEPAY_MONTHLY_LIMIT }, 'SePay monthly transactions near the plan limit');
    }
}

// ── Webhook authentication ─────────────────────────────────────────────────

function sameText(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * SePay signs with HMAC-SHA256 over "{timestamp}.{raw body}" (headers
 * X-SePay-Signature: sha256=<hex>, X-SePay-Timestamp, 5-minute window), or
 * sends "Authorization: Apikey <key>". The secret is preferred when both are set.
 */
export function verifySepayRequest(headers: Record<string, unknown>, rawBody: string, now = Date.now()): boolean {
    if (env.SEPAY_WEBHOOK_SECRET) {
        const signature = String(headers['x-sepay-signature'] ?? '');
        const timestamp = String(headers['x-sepay-timestamp'] ?? '');
        if (!/^\d{9,11}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
        const expected = `sha256=${crypto.createHmac('sha256', env.SEPAY_WEBHOOK_SECRET).update(`${timestamp}.${rawBody}`).digest('hex')}`;
        return sameText(signature, expected);
    }
    if (env.SEPAY_API_KEY) return sameText(String(headers.authorization ?? ''), `Apikey ${env.SEPAY_API_KEY}`);
    return false;
}

export function sepayConfigured(): boolean {
    return Boolean(env.SEPAY_WEBHOOK_SECRET || env.SEPAY_API_KEY);
}
