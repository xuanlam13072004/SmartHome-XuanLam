/**
 * Payments by hand (docs/architecture/payments.md), inside the Gateway container:
 *
 *   docker compose exec api-gateway node dist/tools/payments.js list
 *   docker compose exec api-gateway node dist/tools/payments.js confirm SHABCD2345 [amount]
 *   docker compose exec api-gateway node dist/tools/payments.js cancel SHABCD2345
 *
 * `confirm` is for a transfer you see in the bank app that SePay did not report
 * (or when SePay is not used): it records the amount and activates the plan.
 */
import Redis from 'ioredis';
import { Pool } from 'pg';
import { env } from '../config/env';
import { confirmOrderManually, sepayTransactionsThisMonth } from '../modules/payments/service';

async function main() {
    const [command, code, amountText] = process.argv.slice(2);
    const pg = new Pool({
        host: env.PG_HOST, port: env.PG_PORT, database: env.PG_DATABASE, user: env.PG_USER, password: env.PG_PASSWORD,
        ssl: env.PG_SSL ? { rejectUnauthorized: false } : false, max: 2,
    });
    const redis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
    // Redis only tells open apps about the change; the payment itself is in PostgreSQL.
    redis.on('error', () => undefined);
    const log = { info: () => undefined, warn: (obj: unknown, msg?: string) => console.warn(msg ?? '', obj) };
    try {
        if (command === 'list') {
            const orders = await pg.query(
                `SELECT o.code, a.email, o.plan_code, o.months, o.amount_vnd, o.received_vnd, o.status,
                        o.expires_at < NOW() AS expired, o.created_at
                 FROM payment_orders AS o JOIN accounts AS a ON a.id = o.account_id
                 WHERE o.status IN ('pending', 'review') AND o.created_at > NOW() - interval '7 days'
                 ORDER BY o.created_at DESC LIMIT 50`,
            );
            console.log('Orders waiting (7 days):');
            console.table(orders.rows);
            const unmatched = await pg.query(
                `SELECT provider_ref, amount_vnd, content, received_at FROM payment_transactions
                 WHERE outcome IN ('unmatched', 'already_paid') AND received_at > NOW() - interval '30 days'
                 ORDER BY received_at DESC LIMIT 50`,
            );
            console.log('Transfers without a payable order (30 days):');
            console.table(unmatched.rows);
            console.log(`SePay transactions this month: ${await sepayTransactionsThisMonth(pg)} / ${env.SEPAY_MONTHLY_LIMIT}`);
        } else if (command === 'confirm' && code) {
            const amount = amountText ? Number(amountText) : undefined;
            if (amount !== undefined && !(amount > 0)) throw new Error('amount must be a positive number of VND');
            await redis.connect().catch(() => undefined);
            const result = await confirmOrderManually(
                { pg, redis: redis.status === 'ready' ? redis : null, log }, code.toUpperCase(), amount,
            );
            console.log(`${code}: ${result.outcome}; status ${result.order?.status}, plan until ${result.order?.plan_expires_at ?? '-'}`);
        } else if (command === 'cancel' && code) {
            const result = await pg.query(
                `UPDATE payment_orders SET status = 'cancelled' WHERE code = $1 AND status IN ('pending', 'review') RETURNING code`,
                [code.toUpperCase()],
            );
            console.log(result.rows[0] ? `${code}: cancelled` : `${code}: not open`);
        } else {
            console.log('Usage: payments.js list | confirm <code> [amount] | cancel <code>');
            process.exitCode = 1;
        }
    } finally {
        redis.disconnect();
        await pg.end();
    }
}

main().catch((error) => {
    console.error(error?.message ?? error);
    process.exitCode = 1;
});
