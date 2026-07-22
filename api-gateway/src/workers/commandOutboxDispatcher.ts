import type { Pool } from 'pg';
import type Redis from 'ioredis';
import { env } from '../config/env';

type Logger = {
    debug: (obj: unknown, message?: string) => void;
    warn: (obj: unknown, message?: string) => void;
    error: (obj: unknown, message?: string) => void;
};

export class CommandOutboxDispatcher {
    private timer: NodeJS.Timeout | null = null;
    private running = false;
    private inFlight: Promise<void> | null = null;

    constructor(
        private readonly pgPool: Pool,
        private readonly redis: Redis,
        private readonly logger: Logger
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
                .catch(err => this.logger.error({ err }, 'Command outbox dispatch failed'))
                .finally(() => {
                    this.inFlight = null;
                    this.schedule(500);
                });
        }, delayMs);
        this.timer.unref();
    }

    private async dispatchBatch() {
        await this.pgPool.query(
            `UPDATE command_outbox AS outbox
             SET published_at = NOW(),
                 last_error = 'Delivery skipped because command is no longer pending',
                 updated_at = NOW()
             FROM device_commands AS command
             WHERE outbox.command_id = command.id
               AND outbox.published_at IS NULL
               AND command.status <> 'pending'`
        );

        const result = await this.pgPool.query(
            `SELECT outbox.command_id, outbox.payload
             FROM command_outbox AS outbox
             JOIN device_commands AS command ON command.id = outbox.command_id
             WHERE outbox.published_at IS NULL AND command.status = 'pending'
             ORDER BY outbox.created_at ASC
             LIMIT 100`
        );

        for (const row of result.rows) {
            try {
                const payload = typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload);
                const pipelineResult = await this.redis
                    .pipeline()
                    .set(`command_version:${row.command_id}`, '1', 'EX', 600)
                    .xadd(env.REDIS_COMMAND_STREAM, '*', 'data', payload)
                    .exec();
                const failed = pipelineResult?.find(([err]) => err);
                if (failed) throw failed[0];

                await this.pgPool.query(
                    `UPDATE command_outbox
                     SET published_at = NOW(), attempts = attempts + 1, last_error = NULL, updated_at = NOW()
                     WHERE command_id = $1 AND published_at IS NULL`,
                    [row.command_id]
                );
                this.logger.debug({ commandId: row.command_id }, 'Command published from transactional outbox');
            } catch (err: any) {
                await this.pgPool.query(
                    `UPDATE command_outbox
                     SET attempts = attempts + 1, last_error = $2, updated_at = NOW()
                     WHERE command_id = $1`,
                    [row.command_id, String(err?.message || err).slice(0, 2000)]
                ).catch(updateErr => this.logger.warn({ updateErr, commandId: row.command_id }, 'Failed to record outbox error'));
            }
        }
    }

    async stop() {
        this.running = false;
        if (this.timer) clearTimeout(this.timer);
        if (this.inFlight) await this.inFlight;
    }
}
