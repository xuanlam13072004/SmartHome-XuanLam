import type { Pool } from 'pg';
import type Redis from 'ioredis';
import type { Db } from 'mongodb';
import { env } from '../config/env';

type Logger = {
    debug: (obj: unknown, message?: string) => void;
    warn: (obj: unknown, message?: string) => void;
    error: (obj: unknown, message?: string) => void;
};

export class OperationOutboxDispatcher {
    private timer: NodeJS.Timeout | null = null;
    private running = false;
    private inFlight: Promise<void> | null = null;

    constructor(
        private readonly pgPool: Pool,
        private readonly redis: Redis,
        private readonly mongoDb: Db,
        private readonly logger: Logger,
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
                .catch(error => this.logger.error({ error }, 'Operation outbox dispatch failed'))
                .finally(() => {
                    this.inFlight = null;
                    this.schedule(500);
                });
        }, delayMs);
        this.timer.unref();
    }

    private async dispatchBatch() {
        await this.pgPool.query(
            `UPDATE operation_outbox AS outbox
             SET published_at = NOW(),
                 last_error = 'Delivery skipped because operation is no longer queued'
             FROM device_operations AS operation
             WHERE outbox.operation_id = operation.id
               AND outbox.published_at IS NULL
               AND operation.status <> 'queued'`,
        );
        const result = await this.pgPool.query(
            `SELECT outbox.id, outbox.operation_id, outbox.payload,
                    operation.device_id, operation.timeout_at
             FROM operation_outbox AS outbox
             JOIN device_operations AS operation ON operation.id = outbox.operation_id
             WHERE outbox.published_at IS NULL
               AND outbox.available_at <= NOW()
               AND operation.status = 'queued'
             ORDER BY outbox.id ASC
             LIMIT 100`,
        );

        for (const row of result.rows) {
            try {
                const payload = typeof row.payload === 'string'
                    ? row.payload
                    : JSON.stringify(row.payload);
                await this.redis.xadd(env.REDIS_OPERATION_STREAM, '*', 'data', payload);

                const client = await this.pgPool.connect();
                try {
                    await client.query('BEGIN');
                    const updated = await client.query(
                        `UPDATE device_operations
                         SET status = 'dispatched'
                         WHERE id = $1 AND status = 'queued'
                         RETURNING id`,
                        [row.operation_id],
                    );
                    if (updated.rows.length === 1) {
                        await client.query(
                            `INSERT INTO device_operation_transitions
                                (operation_id, from_status, to_status, metadata)
                             VALUES ($1, 'queued', 'dispatched', $2::jsonb)`,
                            [row.operation_id, JSON.stringify({ stream: env.REDIS_OPERATION_STREAM })],
                        );
                    }
                    await client.query(
                        `UPDATE operation_outbox
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

                await this.mongoDb.collection(env.MONGO_ACTIVE_OPERATIONS_COLLECTION).updateOne(
                    { _id: row.operation_id },
                    {
                        $set: {
                            device_id: row.payload.device_id,
                            status: 'dispatched',
                            operation: row.payload,
                            expires_at: new Date(row.timeout_at),
                            updated_at: new Date(),
                        },
                    },
                    { upsert: true },
                ).catch(error => this.logger.warn(
                    { error, operationId: row.operation_id },
                    'Failed to update active operation projection',
                ));
                this.logger.debug(
                    { operationId: row.operation_id },
                    'Operation published from transactional outbox',
                );
            } catch (error: any) {
                await this.pgPool.query(
                    `UPDATE operation_outbox
                     SET attempt_count = attempt_count + 1,
                         available_at = NOW() + LEAST(60, POWER(2, LEAST(attempt_count, 6))) * INTERVAL '1 second',
                         last_error = $2
                     WHERE id = $1`,
                    [row.id, String(error?.message || error).slice(0, 2000)],
                ).catch(updateError => this.logger.warn(
                    { updateError, operationId: row.operation_id },
                    'Failed to record operation outbox error',
                ));
            }
        }
    }

    async stop() {
        this.running = false;
        if (this.timer) clearTimeout(this.timer);
        if (this.inFlight) await this.inFlight;
    }
}
