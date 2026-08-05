import type { Pool } from 'pg';
import type Redis from 'ioredis';
import { env } from '../config/env';

export class CredentialOutboxDispatcher {
    private timer: NodeJS.Timeout | null = null;
    private running = false;
    private inFlight: Promise<void> | null = null;

    constructor(
        private readonly pgPool: Pool,
        private readonly redis: Redis,
        private readonly logger: any,
    ) {}

    start() {
        if (this.running) return;
        this.running = true;
        this.schedule(0);
    }

    private schedule(delayMs: number) {
        if (!this.running) return;
        this.timer = setTimeout(() => {
            this.inFlight = this.dispatchBatch()
                .catch(error => this.logger.error({ error }, 'Credential outbox dispatch failed'))
                .finally(() => {
                    this.inFlight = null;
                    this.schedule(500);
                });
        }, delayMs);
        this.timer.unref();
    }

    private async dispatchBatch() {
        await this.pgPool.query(
            `UPDATE credential_outbox AS outbox
             SET published_at = NOW(), last_error = 'Delivery skipped because job is terminal'
             FROM credential_jobs AS job
             WHERE outbox.job_id = job.id AND outbox.published_at IS NULL
               AND job.status NOT IN ('queued', 'dispatched')`,
        );
        const result = await this.pgPool.query(
            `SELECT outbox.id, outbox.job_id, outbox.payload
             FROM credential_outbox AS outbox
             JOIN credential_jobs AS job ON job.id = outbox.job_id
             WHERE outbox.published_at IS NULL AND outbox.available_at <= NOW()
               AND job.status = 'queued'
             ORDER BY outbox.id ASC LIMIT 50`,
        );
        for (const row of result.rows) {
            try {
                const payload = typeof row.payload === 'string'
                    ? row.payload
                    : JSON.stringify(row.payload);
                await this.redis.xadd(env.REDIS_CREDENTIAL_STREAM, '*', 'data', payload);
                const client = await this.pgPool.connect();
                try {
                    await client.query('BEGIN');
                    await client.query(
                        `UPDATE credential_jobs SET status = 'dispatched'
                         WHERE id = $1 AND status = 'queued'`,
                        [row.job_id],
                    );
                    await client.query(
                        `UPDATE credential_outbox
                         SET published_at = NOW(), attempt_count = attempt_count + 1,
                             last_error = NULL
                         WHERE id = $1 AND published_at IS NULL`,
                        [row.id],
                    );
                    await client.query('COMMIT');
                } catch (error) {
                    await client.query('ROLLBACK');
                    throw error;
                } finally {
                    client.release();
                }
            } catch (error: any) {
                await this.pgPool.query(
                    `UPDATE credential_outbox
                     SET attempt_count = attempt_count + 1,
                         available_at = NOW() + LEAST(60, POWER(2, LEAST(attempt_count, 6))) * INTERVAL '1 second',
                         last_error = $2 WHERE id = $1`,
                    [row.id, String(error?.message || error).slice(0, 2000)],
                );
            }
        }
    }

    async stop() {
        this.running = false;
        if (this.timer) clearTimeout(this.timer);
        if (this.inFlight) await this.inFlight;
    }
}
