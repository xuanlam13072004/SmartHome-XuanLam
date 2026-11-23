import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env';
import { dayKey, usagePeriod } from '../assistant/quota';
import { sepayTransactionsThisMonth } from '../payments/service';

/**
 * Numbers for the "Tổng quan" and "Trợ lý" tabs. Each answer is computed in a
 * handful of indexed queries and kept 60 seconds in Redis, so leaving the page
 * open costs the database nothing noticeable even with 8k accounts.
 */

const CACHE_SECONDS = 60;
const OVERVIEW_KEY = 'admin:overview:v1';
const ASSISTANT_KEY = 'admin:assistant:v1';
const ZONE = 'Asia/Ho_Chi_Minh';
const DAY_MS = 86_400_000;
const OFFSET_MS = 7 * 3_600_000;
const CHART_DAYS = 30;
const OUTCOMES = ['chat', 'action', 'clarify', 'confirm', 'refused', 'error'] as const;

/** The last [count] days in Vietnam time ('YYYY-MM-DD'), today last, and when the first and today began. */
export function vietnamDays(now: Date, count: number) {
    const today = Math.floor((now.getTime() + OFFSET_MS) / DAY_MS) * DAY_MS - OFFSET_MS;
    const start = today - (count - 1) * DAY_MS;
    return {
        start: new Date(start),
        todayStart: new Date(today),
        days: Array.from({ length: count }, (_, index) => new Date(start + index * DAY_MS + OFFSET_MS).toISOString().slice(0, 10)),
    };
}

/** One value per day (0 where nothing happened). */
export function daySeries(days: string[], rows: Array<{ day: string; value: unknown }>): number[] {
    const byDay = new Map(rows.map(row => [row.day, Number(row.value) || 0]));
    return days.map(day => byDay.get(day) ?? 0);
}

const DAY = (column: string) => `to_char(${column} AT TIME ZONE '${ZONE}', 'YYYY-MM-DD')`;

async function cached<T>(app: FastifyInstance, key: string, build: () => Promise<T>): Promise<T> {
    const hit = await app.redis.get(key);
    if (hit) return JSON.parse(hit) as T;
    const value = await build();
    await app.redis.set(key, JSON.stringify(value), 'EX', CACHE_SECONDS);
    return value;
}

/** Called after a change so the next look at "Tổng quan" shows it. */
export async function forgetOverview(app: FastifyInstance) {
    await app.redis.del(OVERVIEW_KEY, ASSISTANT_KEY).catch(() => undefined);
}

export async function adminOverview(app: FastifyInstance) {
    return cached(app, OVERVIEW_KEY, async () => {
        const now = new Date();
        const { start, todayStart, days } = vietnamDays(now, CHART_DAYS);
        const { period } = usagePeriod(now);
        const monthStart = new Date(`${period}T00:00:00+07:00`);
        const pg = app.pg;
        const [
            accounts, active, devices, online, plans, revenue, open, unmatched, sepay, usage, today,
            newPerDay, revenuePerDay, tokensPerDay,
        ] = await Promise.all([
            pg.query(
                `SELECT count(*)::int AS total,
                        count(*) FILTER (WHERE status = 'disabled')::int AS disabled,
                        count(*) FILTER (WHERE created_at >= $1)::int AS new_today,
                        count(*) FILTER (WHERE created_at >= NOW() - interval '7 days')::int AS new_7d
                 FROM accounts`,
                [todayStart],
            ),
            pg.query(
                `SELECT count(DISTINCT account_id)::int AS count FROM user_sessions
                 WHERE COALESCE(last_used_at, created_at) >= NOW() - interval '7 days'`,
            ),
            pg.query('SELECT product_id, count(*)::int AS count FROM device_metadata WHERE is_active GROUP BY product_id'),
            app.mongo.db.collection(env.MONGO_DEVICE_SHADOWS_COLLECTION).countDocuments({ is_online: true }),
            pg.query(
                `SELECT plan.code, plan.name, count(paid.account_id)::int AS count
                 FROM assistant_plans AS plan
                 LEFT JOIN account_plans AS paid ON paid.plan_code = plan.code AND paid.expires_at > NOW()
                 WHERE plan.price_vnd > 0
                 GROUP BY plan.code, plan.name, plan.position ORDER BY plan.position`,
            ),
            pg.query(
                `SELECT COALESCE(sum(received_vnd) FILTER (WHERE paid_via <> 'mock'), 0)::bigint AS amount,
                        count(*) FILTER (WHERE paid_via <> 'mock')::int AS orders,
                        count(*) FILTER (WHERE paid_via = 'mock')::int AS mock_orders
                 FROM payment_orders WHERE status = 'paid' AND paid_at >= $1`,
                [monthStart],
            ),
            pg.query(
                `SELECT count(*) FILTER (WHERE status = 'review')::int AS review,
                        count(*) FILTER (WHERE status = 'pending' AND expires_at > NOW())::int AS pending
                 FROM payment_orders WHERE status IN ('pending', 'review')`,
            ),
            pg.query(
                `SELECT count(*)::int AS count FROM payment_transactions
                 WHERE outcome IN ('unmatched', 'already_paid') AND received_at > NOW() - interval '30 days'`,
            ),
            sepayTransactionsThisMonth(pg),
            pg.query(
                `SELECT COALESCE(sum(tokens), 0)::bigint AS tokens, COALESCE(sum(requests), 0)::bigint AS requests
                 FROM assistant_usage WHERE period = $1`,
                [period],
            ),
            app.redis.get(dayKey(now)),
            pg.query(`SELECT ${DAY('created_at')} AS day, count(*)::int AS value FROM accounts WHERE created_at >= $1 GROUP BY 1`, [start]),
            pg.query(
                `SELECT ${DAY('paid_at')} AS day, sum(received_vnd)::bigint AS value FROM payment_orders
                 WHERE status = 'paid' AND paid_via <> 'mock' AND paid_at >= $1 GROUP BY 1`,
                [start],
            ),
            pg.query(`SELECT ${DAY('created_at')} AS day, sum(tokens)::bigint AS value FROM assistant_turns WHERE created_at >= $1 GROUP BY 1`, [start]),
        ]);
        const total = accounts.rows[0].total as number;
        const paid = plans.rows.reduce((sum, row) => sum + Number(row.count), 0);
        const byProduct = devices.rows
            .map(row => ({
                product_id: row.product_id as string,
                name: String((app.catalog.getProduct(row.product_id) as any)?.presentation?.display_name || row.product_id),
                count: Number(row.count),
            }))
            .sort((a, b) => b.count - a.count);
        return {
            generated_at: now.toISOString(),
            accounts: { ...accounts.rows[0], active_7d: active.rows[0].count as number },
            devices: {
                total: byProduct.reduce((sum, item) => sum + item.count, 0),
                online,
                by_product: byProduct,
            },
            plans: [
                { code: 'free', name: 'Miễn phí', count: Math.max(0, total - paid) },
                ...plans.rows.map(row => ({ code: row.code as string, name: row.name as string, count: Number(row.count) })),
            ],
            payments: {
                mode: env.PAYMENT_MODE,
                revenue_month_vnd: Number(revenue.rows[0].amount),
                paid_orders_month: revenue.rows[0].orders as number,
                mock_orders_month: revenue.rows[0].mock_orders as number,
                review: open.rows[0].review as number,
                pending: open.rows[0].pending as number,
                unmatched_30d: unmatched.rows[0].count as number,
                sepay_used: sepay,
                sepay_limit: env.SEPAY_MONTHLY_LIMIT,
            },
            assistant: {
                tokens_month: Number(usage.rows[0].tokens),
                requests_month: Number(usage.rows[0].requests),
                tokens_today: Number(today ?? 0),
                daily_cap: env.ASSISTANT_DAILY_TOKEN_CAP,
            },
            daily: {
                days,
                new_accounts: daySeries(days, newPerDay.rows),
                revenue_vnd: daySeries(days, revenuePerDay.rows),
                assistant_tokens: daySeries(days, tokensPerDay.rows),
            },
        };
    });
}

/** "Trợ lý": usage this month by plan, the heaviest accounts, turns per day by outcome. No message is ever read. */
export async function adminAssistant(app: FastifyInstance) {
    return cached(app, ASSISTANT_KEY, async () => {
        const now = new Date();
        const { start, days } = vietnamDays(now, CHART_DAYS);
        const { period } = usagePeriod(now);
        const pg = app.pg;
        const [plans, byPlan, top, perDay, channels, today] = await Promise.all([
            pg.query('SELECT code, name, monthly_tokens FROM assistant_plans ORDER BY position'),
            pg.query(
                `SELECT COALESCE(paid.plan_code, 'free') AS code, count(*)::int AS accounts,
                        sum(usage.tokens)::bigint AS tokens, sum(usage.requests)::bigint AS requests
                 FROM assistant_usage AS usage
                 LEFT JOIN account_plans AS paid ON paid.account_id = usage.account_id AND paid.expires_at > NOW()
                 WHERE usage.period = $1
                 GROUP BY 1`,
                [period],
            ),
            pg.query(
                `SELECT usage.account_id, account.email, account.full_name, account.status,
                        usage.tokens, usage.requests, plan.code AS plan_code, plan.name AS plan_name, plan.monthly_tokens
                 FROM assistant_usage AS usage
                 JOIN accounts AS account ON account.id = usage.account_id
                 LEFT JOIN account_plans AS paid ON paid.account_id = usage.account_id AND paid.expires_at > NOW()
                 JOIN assistant_plans AS plan ON plan.code = COALESCE(paid.plan_code, 'free')
                 WHERE usage.period = $1
                 ORDER BY usage.tokens DESC
                 LIMIT 20`,
                [period],
            ),
            pg.query(
                `SELECT ${DAY('created_at')} AS day, outcome, count(*)::int AS turns, sum(tokens)::bigint AS tokens
                 FROM assistant_turns WHERE created_at >= $1 GROUP BY 1, 2`,
                [start],
            ),
            pg.query(
                `SELECT channel, count(*)::int AS turns FROM assistant_turns WHERE created_at >= $1 GROUP BY channel`,
                [start],
            ),
            app.redis.get(dayKey(now)),
        ]);
        const usage = new Map(byPlan.rows.map(row => [row.code as string, row]));
        const outcomes = Object.fromEntries(OUTCOMES.map(outcome => [
            outcome,
            daySeries(days, perDay.rows.filter(row => row.outcome === outcome).map(row => ({ day: row.day, value: row.turns }))),
        ]));
        const tokensPerDay = new Map<string, number>();
        for (const row of perDay.rows) tokensPerDay.set(row.day, (tokensPerDay.get(row.day) ?? 0) + Number(row.tokens));
        return {
            generated_at: now.toISOString(),
            period,
            tokens_today: Number(today ?? 0),
            daily_cap: env.ASSISTANT_DAILY_TOKEN_CAP,
            by_plan: plans.rows.map(plan => ({
                code: plan.code as string,
                name: plan.name as string,
                monthly_tokens: Number(plan.monthly_tokens),
                accounts: Number(usage.get(plan.code)?.accounts ?? 0),
                tokens: Number(usage.get(plan.code)?.tokens ?? 0),
                requests: Number(usage.get(plan.code)?.requests ?? 0),
            })),
            top: top.rows.map(row => ({
                account_id: row.account_id as string,
                email: row.email as string,
                full_name: row.full_name as string,
                status: row.status as string,
                plan: { code: row.plan_code as string, name: row.plan_name as string },
                tokens: Number(row.tokens),
                requests: Number(row.requests),
                monthly_tokens: Number(row.monthly_tokens),
            })),
            daily: {
                days,
                outcomes,
                tokens: days.map(day => tokensPerDay.get(day) ?? 0),
            },
            channels: Object.fromEntries(channels.rows.map(row => [row.channel as string, Number(row.turns)])),
        };
    });
}

export async function giftablePlans(app: FastifyInstance) {
    const result = await app.pg.query(
        `SELECT code, name, monthly_tokens, price_vnd FROM assistant_plans
         WHERE is_active AND price_vnd > 0 ORDER BY position`,
    );
    return result.rows.map(row => ({
        code: row.code as string,
        name: row.name as string,
        monthly_tokens: Number(row.monthly_tokens),
        price_vnd: Number(row.price_vnd),
    }));
}
