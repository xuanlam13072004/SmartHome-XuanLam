import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env';
import { httpError } from '../../utils/httpError';

/**
 * Plans and token allowances. Usage counts the tokens Gemini reports for each
 * turn, per calendar month in Vietnam time. Only the assistant is limited:
 * controlling devices in the app and safety alerts never depend on a plan.
 * A daily ceiling for the whole system protects the shared API key.
 */

export interface PlanView {
    code: string;
    name: string;
    monthly_tokens: number;
    price_vnd: number;
    /** Twelve months at once (null for the free plan). */
    price_12m_vnd: number | null;
}

const ZONE = 'Asia/Ho_Chi_Minh';

/** 'YYYY-MM-01' of [now] in Vietnam, and when the next month starts. */
export function usagePeriod(now = new Date()): { period: string; resetsAt: Date } {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit' }).formatToParts(now);
    const year = Number(parts.find(part => part.type === 'year')!.value);
    const month = Number(parts.find(part => part.type === 'month')!.value);
    const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
    // Midnight in Vietnam (UTC+7, no daylight saving) is 17:00 UTC the day before.
    const resetsAt = new Date(Date.UTC(next.year, next.month - 1, 1, 0, 0, 0) - 7 * 3600_000);
    return { period: `${year}-${String(month).padStart(2, '0')}-01`, resetsAt };
}

/** Redis counter of the tokens the whole system used today (UTC day): the daily ceiling. */
export const dayKey = (now = new Date()) => `assistant:tokens:${now.toISOString().slice(0, 10)}`;

function toPlan(row: any): PlanView {
    return {
        code: row.code,
        name: row.name,
        monthly_tokens: Number(row.monthly_tokens),
        price_vnd: Number(row.price_vnd),
        price_12m_vnd: row.price_12m_vnd === null || row.price_12m_vnd === undefined ? null : Number(row.price_12m_vnd),
    };
}

export async function listPlans(app: FastifyInstance): Promise<PlanView[]> {
    const result = await app.pg.query(
        'SELECT code, name, monthly_tokens, price_vnd, price_12m_vnd FROM assistant_plans WHERE is_active ORDER BY position',
    );
    return result.rows.map(toPlan);
}

/** The account's current plan: a paid plan until it expires, otherwise the free plan. */
export async function effectivePlan(app: FastifyInstance, accountId: string): Promise<PlanView & { expires_at: string | null }> {
    const result = await app.pg.query(
        `SELECT plan.code, plan.name, plan.monthly_tokens, plan.price_vnd, plan.price_12m_vnd, paid.expires_at
         FROM assistant_plans AS plan
         LEFT JOIN account_plans AS paid
           ON paid.account_id = $1 AND paid.plan_code = plan.code AND paid.expires_at > NOW()
         WHERE plan.code = COALESCE(
             (SELECT plan_code FROM account_plans WHERE account_id = $1 AND expires_at > NOW()), 'free')`,
        [accountId],
    );
    const row = result.rows[0];
    if (!row) throw httpError(500, 'ASSISTANT_PLAN_MISSING', 'The free plan is missing');
    return { ...toPlan(row), expires_at: row.expires_at ? new Date(row.expires_at).toISOString() : null };
}

export async function usageSummary(app: FastifyInstance, accountId: string) {
    const { period, resetsAt } = usagePeriod();
    const [plan, usage] = await Promise.all([
        effectivePlan(app, accountId),
        app.pg.query('SELECT tokens, requests FROM assistant_usage WHERE account_id = $1 AND period = $2', [accountId, period]),
    ]);
    const used = Number(usage.rows[0]?.tokens ?? 0);
    return {
        plan,
        period_start: period,
        resets_at: resetsAt.toISOString(),
        used_tokens: used,
        remaining_tokens: Math.max(0, plan.monthly_tokens - used),
        requests: Number(usage.rows[0]?.requests ?? 0),
    };
}

/** Refuses a turn when the month's allowance or the system's daily ceiling is used up. */
export async function assertQuota(app: FastifyInstance, accountId: string) {
    const [summary, today] = await Promise.all([usageSummary(app, accountId), app.redis.get(dayKey())]);
    if (summary.remaining_tokens <= 0) {
        const error = httpError(429, 'ASSISTANT_QUOTA_EXCEEDED',
            `Bạn đã dùng hết lượt trợ lý của gói ${summary.plan.name} tháng này. Nâng cấp gói để dùng tiếp.`) as any;
        error.details = { plan: summary.plan.code, resets_at: summary.resets_at };
        throw error;
    }
    if (Number(today ?? 0) >= env.ASSISTANT_DAILY_TOKEN_CAP) {
        throw httpError(503, 'ASSISTANT_BUSY', 'Trợ lý đang quá tải, hãy thử lại sau.');
    }
    return summary;
}

export async function addUsage(app: FastifyInstance, accountId: string, tokens: number) {
    const { period } = usagePeriod();
    await app.pg.query(
        `INSERT INTO assistant_usage (account_id, period, tokens, requests) VALUES ($1, $2, $3, 1)
         ON CONFLICT (account_id, period)
         DO UPDATE SET tokens = assistant_usage.tokens + EXCLUDED.tokens, requests = assistant_usage.requests + 1`,
        [accountId, period, Math.max(0, Math.round(tokens))],
    );
    await app.redis.multi().incrby(dayKey(), Math.max(0, Math.round(tokens))).expire(dayKey(), 2 * 86400).exec();
}
