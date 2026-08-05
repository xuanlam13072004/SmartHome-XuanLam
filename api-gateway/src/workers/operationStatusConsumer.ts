import type { Pool, PoolClient } from 'pg';
import type Redis from 'ioredis';
import type { Db } from 'mongodb';
import { env } from '../config/env';
// @ts-ignore - shared CommonJS module
import { OPERATION_STATUS, REDIS_CHANNELS, TERMINAL_OPERATION_STATUSES } from '../../../shared/constants';

const ACTIVE = new Set(['accepted', 'queued', 'dispatched', 'executing']);
const ALLOWED_TRANSITIONS: Record<string, Set<string>> = {
    accepted: new Set(['queued', 'cancelled', 'timed_out']),
    queued: new Set(['dispatched', 'cancelled', 'timed_out']),
    dispatched: new Set(['executing', 'succeeded', 'rejected', 'failed', 'timed_out', 'cancelled']),
    executing: new Set(['succeeded', 'rejected', 'failed', 'timed_out', 'cancelled']),
};

export class OperationStatusConsumer {
    private readonly blockingRedis: Redis;
    private readonly consumerName: string;
    private running = false;
    private timeoutTimer: NodeJS.Timeout | null = null;

    constructor(
        private readonly pgPool: Pool,
        private readonly redis: Redis,
        private readonly logger: any,
        private readonly mongoDb: Db,
    ) {
        this.blockingRedis = redis.duplicate();
        this.consumerName = `gateway-operation-${Math.random().toString(36).slice(2, 9)}`;
    }

    async start() {
        this.running = true;
        await this.blockingRedis.ping();
        try {
            await this.blockingRedis.call(
                'XGROUP',
                'CREATE',
                env.REDIS_OPERATION_STATUS_STREAM,
                'operation-status-sync',
                '$',
                'MKSTREAM',
            );
        } catch (error: any) {
            if (!String(error?.message).includes('BUSYGROUP')) throw error;
        }
        this.timeoutTimer = setInterval(() => {
            this.expireTimedOutOperations().catch(error => this.logger.error(
                { error },
                'Failed to expire timed-out operations',
            ));
        }, 5000);
        this.timeoutTimer.unref();
        void this.consumeLoop();
    }

    private async transition(
        client: PoolClient,
        operationId: string,
        nextStatus: string,
        reasonCode: string | null,
        metadata: Record<string, unknown>,
    ) {
        const result = await client.query(
            `SELECT operation.id, operation.status, device.mac,
                    operation.actor_account_id
             FROM device_operations AS operation
             JOIN device_metadata AS device ON device.id = operation.device_id
             WHERE operation.id = $1
             FOR UPDATE OF operation`,
            [operationId],
        );
        const operation = result.rows[0];
        if (!operation || !ACTIVE.has(operation.status)) return null;
        if (!ALLOWED_TRANSITIONS[operation.status]?.has(nextStatus)) return null;
        const terminal = TERMINAL_OPERATION_STATUSES.has(nextStatus);
        await client.query(
            `UPDATE device_operations
             SET status = $2, reason_code = $3,
                 completed_at = CASE WHEN $4 THEN NOW() ELSE NULL END
             WHERE id = $1`,
            [operationId, nextStatus, reasonCode, terminal],
        );
        await client.query(
            `INSERT INTO device_operation_transitions
                (operation_id, from_status, to_status, reason_code, metadata)
             VALUES ($1, $2, $3, $4, $5::jsonb)`,
            [operationId, operation.status, nextStatus, reasonCode, JSON.stringify(metadata)],
        );
        if (terminal) {
            const resourceLocator = typeof metadata?.details === 'object'
                && metadata.details !== null
                && typeof (metadata.details as any).resource_locator === 'string'
                ? (metadata.details as any).resource_locator
                : null;
            if (nextStatus === OPERATION_STATUS.SUCCEEDED && resourceLocator) {
                await client.query(
                    `UPDATE device_resource_sessions
                     SET status = 'ready', resource_locator = $2, ready_at = NOW(),
                         reason_code = NULL
                     WHERE operation_id = $1 AND status = 'requested'
                       AND expires_at > NOW()`,
                    [operationId, resourceLocator],
                );
            } else {
                await client.query(
                    `UPDATE device_resource_sessions
                     SET status = 'failed', reason_code = $2
                     WHERE operation_id = $1 AND status = 'requested'`,
                    [
                        operationId,
                        reasonCode || (
                            nextStatus === OPERATION_STATUS.SUCCEEDED
                                ? 'RESOURCE_LOCATOR_MISSING'
                                : `OPERATION_${nextStatus.toUpperCase()}`
                        ),
                    ],
                );
            }
        }
        return { ...operation, status: nextStatus, terminal };
    }

    private async publishProjection(operation: any, reasonCode: string | null) {
        if (operation.terminal) {
            await this.mongoDb.collection(env.MONGO_ACTIVE_OPERATIONS_COLLECTION)
                .deleteOne({ _id: operation.id });
        } else {
            await this.mongoDb.collection(env.MONGO_ACTIVE_OPERATIONS_COLLECTION).updateOne(
                { _id: operation.id },
                { $set: { status: operation.status, updated_at: new Date() } },
            );
        }
        await this.redis.publish(REDIS_CHANNELS.DEVICE_OPERATION, JSON.stringify({
            owner_id: operation.actor_account_id,
            mac: operation.mac,
            payload: {
                operation_id: operation.id,
                status: operation.status,
                reason_code: reasonCode,
            },
            timestamp: new Date().toISOString(),
        }));
    }

    private async expireTimedOutOperations() {
        const result = await this.pgPool.query(
            `SELECT id FROM device_operations
             WHERE status IN ('accepted', 'queued', 'dispatched', 'executing')
               AND timeout_at <= NOW()
             ORDER BY timeout_at ASC
             LIMIT 100`,
        );
        for (const row of result.rows) {
            const client = await this.pgPool.connect();
            try {
                await client.query('BEGIN');
                const operation = await this.transition(
                    client,
                    row.id,
                    OPERATION_STATUS.TIMED_OUT,
                    'OPERATION_TIMEOUT',
                    { source: 'gateway_timeout_sweeper' },
                );
                await client.query('COMMIT');
                if (operation) await this.publishProjection(operation, 'OPERATION_TIMEOUT');
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            } finally {
                client.release();
            }
        }
    }

    private async processMessage(messageId: string, fields: string[]) {
        const payload: Record<string, any> = {};
        for (let index = 0; index < fields.length; index += 2) {
            if (fields[index] === 'data') Object.assign(payload, JSON.parse(fields[index + 1]));
            else payload[fields[index]] = fields[index + 1];
        }
        const operationId = payload.operation_id;
        const status = payload.status;
        if (!operationId || !Object.values(OPERATION_STATUS).includes(status)) {
            this.logger.warn({ payload }, 'Invalid operation status message discarded');
            await this.redis.call(
                'XACK', env.REDIS_OPERATION_STATUS_STREAM, 'operation-status-sync', messageId,
            );
            return;
        }

        const client = await this.pgPool.connect();
        try {
            await client.query('BEGIN');
            const operation = await this.transition(
                client,
                operationId,
                status,
                payload.reason_code || null,
                { source: 'mqtt_worker', details: payload.details || {} },
            );
            await client.query('COMMIT');
            if (operation) await this.publishProjection(operation, payload.reason_code || null);
            await this.redis.call(
                'XACK', env.REDIS_OPERATION_STATUS_STREAM, 'operation-status-sync', messageId,
            );
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    private async consumeLoop() {
        while (this.running) {
            try {
                const messages: any = await this.blockingRedis.call(
                    'XREADGROUP',
                    'GROUP',
                    'operation-status-sync',
                    this.consumerName,
                    'BLOCK',
                    5000,
                    'COUNT',
                    20,
                    'STREAMS',
                    env.REDIS_OPERATION_STATUS_STREAM,
                    '>',
                );
                if (!messages) continue;
                for (const [messageId, fields] of messages[0][1]) {
                    await this.processMessage(messageId, fields);
                }
            } catch (error: any) {
                if (!this.running) break;
                this.logger.error({ error }, 'Operation status consumer failed');
                if (String(error?.message).includes('NOGROUP')) {
                    try {
                        await this.blockingRedis.call(
                            'XGROUP',
                            'CREATE',
                            env.REDIS_OPERATION_STATUS_STREAM,
                            'operation-status-sync',
                            '$',
                            'MKSTREAM',
                        );
                    } catch (groupError: any) {
                        if (!String(groupError?.message).includes('BUSYGROUP')) {
                            this.logger.error({ groupError }, 'Unable to recreate operation status group');
                        }
                    }
                }
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
