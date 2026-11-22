import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { REDIS_CHANNELS } from '../../../../shared/constants';

/**
 * Reminders before a paid assistant plan ends: 3 days and 1 day before, and
 * once it has ended (back to the free plan). Each (account, end date, stage)
 * is recorded in `plan_reminders`, so a reminder goes out once even with
 * several Gateways, and renewing (a new end date) starts a new round. The
 * reminder is an account event: open apps show it, the push notifier sends
 * it to phones. A plan that ended more than a day ago is not announced late.
 */

const BATCH = 500;

export async function sendPlanReminders(deps: {
    pg: Pool;
    redis: Pick<Redis, 'publish'>;
    log: { warn: (obj: object, msg: string) => void };
}): Promise<number> {
    let total = 0;
    for (;;) {
        const result = await deps.pg.query(
            `WITH due AS (
                 SELECT account_id, expires_at,
                        CASE WHEN expires_at <= NOW() THEN 'expired'
                             WHEN expires_at <= NOW() + interval '1 day' THEN '1d'
                             ELSE '3d' END AS stage
                 FROM account_plans
                 WHERE expires_at > NOW() - interval '1 day' AND expires_at <= NOW() + interval '3 days'
             ), fresh AS (
                 SELECT due.* FROM due
                 WHERE NOT EXISTS (
                     SELECT 1 FROM plan_reminders AS sent
                     WHERE sent.account_id = due.account_id AND sent.plan_expires_at = due.expires_at
                       AND sent.stage = due.stage)
                 LIMIT $1
             ), inserted AS (
                 INSERT INTO plan_reminders (account_id, plan_expires_at, stage)
                 SELECT account_id, expires_at, stage FROM fresh
                 ON CONFLICT DO NOTHING
                 RETURNING account_id, plan_expires_at, stage
             )
             SELECT inserted.account_id, inserted.plan_expires_at, inserted.stage, plan.code, plan.name
             FROM inserted
             JOIN account_plans AS paid ON paid.account_id = inserted.account_id
             JOIN assistant_plans AS plan ON plan.code = paid.plan_code`,
            [BATCH],
        );
        for (const row of result.rows) {
            const expiresAt = new Date(row.plan_expires_at).toISOString();
            const plan = { code: row.code, name: row.name };
            const message = row.stage === 'expired'
                ? { account_id: row.account_id, event: 'plan_expired', data: { plan, expired_at: expiresAt } }
                : { account_id: row.account_id, event: 'plan_expiring', data: { plan, expires_at: expiresAt, stage: row.stage } };
            await deps.redis.publish(REDIS_CHANNELS.ACCOUNT_EVENT, JSON.stringify(message))
                .catch(error => deps.log.warn({ error }, 'Failed to publish a plan reminder'));
        }
        total += result.rows.length;
        if (result.rows.length < BATCH) return total;
    }
}

export async function purgeOldPlanReminders(pg: Pool): Promise<number> {
    const result = await pg.query(
        `DELETE FROM plan_reminders WHERE (account_id, plan_expires_at, stage) IN (
             SELECT account_id, plan_expires_at, stage FROM plan_reminders
             WHERE sent_at < NOW() - interval '400 days' LIMIT 5000)`,
    );
    return result.rowCount ?? 0;
}
