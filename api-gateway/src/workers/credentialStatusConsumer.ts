import type { Pool } from 'pg';
import type Redis from 'ioredis';
import { env } from '../config/env';
// @ts-ignore - shared CommonJS module
import { REDIS_CHANNELS } from '../../../shared/constants';

const TERMINAL = new Set(['succeeded', 'rejected', 'failed', 'timed_out']);

export class CredentialStatusConsumer {
    private readonly blockingRedis: Redis;
    private readonly consumerName = `gateway-credential-${Math.random().toString(36).slice(2, 9)}`;
    private running = false;
    private timeoutTimer: NodeJS.Timeout | null = null;

    constructor(
        private readonly pgPool: Pool,
        private readonly redis: Redis,
        private readonly logger: any,
    ) {
        this.blockingRedis = redis.duplicate();
    }

    async start() {
        this.running = true;
        await this.blockingRedis.ping();
        await this.ensureGroup();
        this.timeoutTimer = setInterval(() => {
            this.expireJobs().catch(error => this.logger.error(
                { error }, 'Failed to expire credential jobs',
            ));
        }, 5000);
        this.timeoutTimer.unref();
        void this.consumeLoop();
    }

    private async ensureGroup() {
        try {
            await this.blockingRedis.call(
                'XGROUP', 'CREATE', env.REDIS_CREDENTIAL_STATUS_STREAM,
                'credential-status-sync', '$', 'MKSTREAM',
            );
        } catch (error: any) {
            if (!String(error?.message).includes('BUSYGROUP')) throw error;
        }
    }

    private async applyStatus(jobId: string, status: string, reasonCode: string | null) {
        if (!TERMINAL.has(status)) return null;
        const client = await this.pgPool.connect();
        try {
            await client.query('BEGIN');
            const result = await client.query(
                `SELECT job.id, job.status, job.credential_id, job.actor_account_id,
                        device.mac
                 FROM credential_jobs AS job
                 JOIN device_metadata AS device ON device.id = job.device_id
                 WHERE job.id = $1 FOR UPDATE OF job`,
                [jobId],
            );
            const job = result.rows[0];
            if (!job || !['queued', 'dispatched'].includes(job.status)) {
                await client.query('ROLLBACK');
                return null;
            }
            await client.query(
                `UPDATE credential_jobs
                 SET status = $2, reason_code = $3, completed_at = NOW()
                 WHERE id = $1`,
                [jobId, status, reasonCode],
            );
            if (job.credential_id) {
                await client.query(
                    `UPDATE device_credentials SET status = $2
                     WHERE id = $1 AND status = 'pending'`,
                    [job.credential_id, status === 'succeeded' ? 'active' : 'failed'],
                );
            }
            await client.query('COMMIT');
            return job;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    private async publish(job: any, jobId: string, status: string, reasonCode: string | null) {
        await this.redis.publish(REDIS_CHANNELS.DEVICE_CREDENTIAL, JSON.stringify({
            owner_id: job.actor_account_id,
            mac: job.mac,
            payload: { job_id: jobId, status, reason_code: reasonCode },
            timestamp: new Date().toISOString(),
        }));
    }

    private async expireJobs() {
        const result = await this.pgPool.query(
            `SELECT id FROM credential_jobs
             WHERE status IN ('queued', 'dispatched') AND timeout_at <= NOW()
             ORDER BY timeout_at ASC LIMIT 100`,
        );
        for (const row of result.rows) {
            const job = await this.applyStatus(row.id, 'timed_out', 'CREDENTIAL_TIMEOUT');
            if (job) await this.publish(job, row.id, 'timed_out', 'CREDENTIAL_TIMEOUT');
        }
    }

    private async processMessage(messageId: string, fields: string[]) {
        const payload: Record<string, any> = {};
        for (let index = 0; index < fields.length; index += 2) {
            if (fields[index] === 'data') Object.assign(payload, JSON.parse(fields[index + 1]));
            else payload[fields[index]] = fields[index + 1];
        }
        if (!payload.job_id || !TERMINAL.has(payload.status)) {
            this.logger.warn({ payload }, 'Invalid credential status message discarded');
        } else {
            const job = await this.applyStatus(
                payload.job_id, payload.status, payload.reason_code || null,
            );
            if (job) await this.publish(
                job, payload.job_id, payload.status, payload.reason_code || null,
            );
        }
        await this.redis.call(
            'XACK', env.REDIS_CREDENTIAL_STATUS_STREAM, 'credential-status-sync', messageId,
        );
    }

    private async consumeLoop() {
        while (this.running) {
            try {
                const messages: any = await this.blockingRedis.call(
                    'XREADGROUP', 'GROUP', 'credential-status-sync', this.consumerName,
                    'BLOCK', 5000, 'COUNT', 20, 'STREAMS',
                    env.REDIS_CREDENTIAL_STATUS_STREAM, '>',
                );
                if (!messages) continue;
                for (const [messageId, fields] of messages[0][1]) {
                    await this.processMessage(messageId, fields);
                }
            } catch (error: any) {
                if (!this.running) break;
                this.logger.error({ error }, 'Credential status consumer failed');
                if (String(error?.message).includes('NOGROUP')) await this.ensureGroup();
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }

    async stop() {
        this.running = false;
        if (this.timeoutTimer) clearInterval(this.timeoutTimer);
        await this.blockingRedis.quit().catch(() => this.blockingRedis.disconnect());
    }
}
