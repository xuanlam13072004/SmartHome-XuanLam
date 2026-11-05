import type { Pool, PoolClient } from 'pg';
import type Redis from 'ioredis';
import type { Db } from 'mongodb';
import { env } from '../config/env';
// @ts-ignore - shared CommonJS module
import { OPERATION_STATUS, REDIS_CHANNELS, TERMINAL_OPERATION_STATUSES } from '../../../shared/constants';
import {
    boundOperationResult,
    buildMediaLocator,
    revokeMediaSessions,
    updateMediaSessionProjection,
} from '../modules/device/mediaSessions';

const ACTIVE = new Set(['accepted', 'queued', 'dispatched', 'executing']);
const ALLOWED_TRANSITIONS: Record<string, Set<string>> = {
    accepted: new Set(['queued', 'cancelled', 'timed_out']),
    queued: new Set(['dispatched', 'cancelled', 'timed_out']),
    dispatched: new Set(['executing', 'succeeded', 'rejected', 'failed', 'timed_out', 'cancelled']),
    executing: new Set(['succeeded', 'rejected', 'failed', 'timed_out', 'cancelled']),
};

/**
 * Where a ready resource session can be opened. Video always goes through the
 * media relay, so the Gateway builds the locator and ignores any device value;
 * other resource kinds keep the device-provided locator (camera-contract 7.1).
 */
export function resolveResourceLocator(
    resourceKind: string,
    sessionId: string,
    details: unknown,
    mediaPublicUrl: string | undefined = env.MEDIA_PUBLIC_URL,
): { locator: string | null; failureCode: string } {
    if (resourceKind === 'video_stream') {
        return mediaPublicUrl
            ? { locator: buildMediaLocator(mediaPublicUrl, sessionId), failureCode: '' }
            : { locator: null, failureCode: 'MEDIA_RELAY_NOT_CONFIGURED' };
    }
    const deviceLocator = details && typeof details === 'object'
        && typeof (details as any).resource_locator === 'string'
        ? (details as any).resource_locator
        : null;
    return { locator: deviceLocator, failureCode: 'RESOURCE_LOCATOR_MISSING' };
}

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
        // Bounded device ACK details (for example list_recordings ranges) are
        // kept as the operation result and returned to the actor (contract B1).
        const operationResult = terminal ? boundOperationResult(metadata?.details) : null;
        await client.query(
            `UPDATE device_operations
             SET status = $2, reason_code = $3,
                 completed_at = CASE WHEN $4 THEN NOW() ELSE NULL END,
                 result = CASE WHEN $4 THEN $5::jsonb ELSE result END
             WHERE id = $1`,
            [operationId, nextStatus, reasonCode, terminal,
                operationResult ? JSON.stringify(operationResult) : null],
        );
        await client.query(
            `INSERT INTO device_operation_transitions
                (operation_id, from_status, to_status, reason_code, metadata)
             VALUES ($1, $2, $3, $4, $5::jsonb)`,
            [operationId, operation.status, nextStatus, reasonCode, JSON.stringify(metadata)],
        );
        let mediaSession: { id: string; status: 'ready' | 'failed' } | null = null;
        if (terminal) {
            const sessionResult = await client.query(
                `SELECT id, resource_kind FROM device_resource_sessions
                 WHERE operation_id = $1 AND status = 'requested'`,
                [operationId],
            );
            const session = sessionResult.rows[0];
            if (session) {
                const locator = resolveResourceLocator(session.resource_kind, session.id, metadata?.details);
                const succeeded = nextStatus === OPERATION_STATUS.SUCCEEDED && locator.locator !== null;
                if (succeeded) {
                    await client.query(
                        `UPDATE device_resource_sessions
                         SET status = 'ready', resource_locator = $2, ready_at = NOW(),
                             reason_code = NULL
                         WHERE id = $1 AND status = 'requested'
                           AND expires_at > NOW()`,
                        [session.id, locator.locator],
                    );
                } else {
                    await client.query(
                        `UPDATE device_resource_sessions
                         SET status = 'failed', reason_code = $2
                         WHERE id = $1 AND status = 'requested'`,
                        [
                            session.id,
                            reasonCode || (
                                nextStatus === OPERATION_STATUS.SUCCEEDED
                                    ? locator.failureCode
                                    : `OPERATION_${nextStatus.toUpperCase()}`
                            ),
                        ],
                    );
                }
                if (session.resource_kind === 'video_stream') {
                    mediaSession = { id: session.id, status: succeeded ? 'ready' : 'failed' };
                }
            }
        }
        return { ...operation, status: nextStatus, terminal, result: operationResult, mediaSession };
    }

    private async publishProjection(operation: any, reasonCode: string | null) {
        if (operation.mediaSession?.status === 'ready') {
            await updateMediaSessionProjection(this.redis, operation.mediaSession.id, { status: 'ready' })
                .catch(error => this.logger.warn({ error }, 'Failed to mark media session ready'));
        } else if (operation.mediaSession?.status === 'failed') {
            await revokeMediaSessions(this.redis, operation.mac, [operation.mediaSession.id])
                .catch(error => this.logger.warn({ error }, 'Failed to drop failed media session'));
        }
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
                ...(operation.result ? { result: operation.result } : {}),
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
