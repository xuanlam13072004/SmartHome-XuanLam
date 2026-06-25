import { Pool } from 'pg';
import Redis from 'ioredis';
import type { Db } from 'mongodb';
import { env } from '../config/env';
// @ts-ignore
import { REDIS_CHANNELS, COMMAND_STATUS } from '../../../shared/constants';

/**
 * CommandStatusConsumer
 * - Tiêu thụ các sự kiện cập nhật trạng thái lệnh (sent, acked, failed) từ Redis Stream
 * - Cập nhật đồng bộ các trạng thái này vào bảng device_commands trong PostgreSQL
 * - Chạy định kỳ một task kiểm tra các lệnh bị quá thời gian chờ (timeout) để tự động hủy
 */
export class CommandStatusConsumer {
    private pgPool: Pool;
    private redis: Redis;
    private logger: any;
    private mongoDb: Db | null;
    private isRunning: boolean = false;
    private timeoutTimer: NodeJS.Timeout | null = null;
    private consumerName: string;

    constructor(pgPool: Pool, redis: Redis, logger: any, mongoDb?: Db) {
        this.pgPool = pgPool;
        this.redis = redis;
        this.logger = logger;
        this.mongoDb = mongoDb || null;
        this.consumerName = `gateway-sync-worker-${Math.random().toString(36).substring(2, 7)}`;
    }

    async start() {
        this.isRunning = true;
        this.logger.info('Starting CommandStatusConsumer worker...');

        // Step 1: Tạo Consumer Group trên Redis Stream nếu chưa tồn tại
        const streamKey = env.REDIS_COMMAND_STATUS_STREAM;
        const groupName = 'command-sync-group';
        try {
            await this.redis.call('XGROUP', 'CREATE', streamKey, groupName, '$', 'MKSTREAM');
            this.logger.info(`Created consumer group ${groupName} for stream ${streamKey}`);
        } catch (err: any) {
            if (err.message.includes('BUSYGROUP')) {
                this.logger.debug(`Consumer group ${groupName} already exists`);
            } else {
                this.logger.error({ err }, 'Failed to create consumer group');
                throw err;
            }
        }

        // Step 2: Bắt đầu chạy vòng lặp kiểm tra Timeout cho lệnh
        this.startTimeoutChecker();

        // Step 3: Bắt đầu vòng lặp tiêu thụ thông điệp trạng thái lệnh
        this.runConsumerLoop(streamKey, groupName);
    }

    private startTimeoutChecker() {
        const intervalMs = 10000; // Chạy mỗi 10 giây
        this.logger.info(`Starting timeout checker loop every ${intervalMs / 1000}s`);

        this.timeoutTimer = setInterval(async () => {
            try {
                // 1. Quét tìm các lệnh hết hạn
                const findQuery = `
                    SELECT id FROM device_commands
                    WHERE (status = '${COMMAND_STATUS.SENT}' OR status = '${COMMAND_STATUS.SENDING}' OR status = '${COMMAND_STATUS.PENDING}')
                      AND updated_at < NOW() - $1 * INTERVAL '1 second'
                `;
                const findResult = await this.pgPool.query(findQuery, [env.COMMAND_TIMEOUT_SECONDS]);
                
                if (findResult.rows.length === 0) {
                    return;
                }

                // 2. Với mỗi lệnh hết hạn, tăng version trong Redis và cập nhật Postgres
                for (const row of findResult.rows) {
                    const commandId = row.id;
                    try {
                        const versionKey = `command_version:${commandId}`;
                        const newVersion = await this.redis.incr(versionKey);

                        // Ghi nhận khóa timeout vào Redis để chống race condition với ACK trễ
                        const lockKey = `command_lock:${commandId}`;
                        await this.redis.set(lockKey, 'timeout', 'EX', 86400); // Khóa trong 24h
                        
                        const updateQuery = `
                            UPDATE device_commands
                            SET status = '${COMMAND_STATUS.TIMEOUT}', event_version = $1, error_log = 'ACK timeout exceeded', updated_at = NOW()
                            WHERE id = $2 
                              AND $1 > event_version
                              AND status NOT IN ('${COMMAND_STATUS.ACKED}', '${COMMAND_STATUS.FAILED}', '${COMMAND_STATUS.TIMEOUT}')
                            RETURNING owner_id, mac
                        `;
                        const updateResult = await this.pgPool.query(updateQuery, [newVersion, commandId]);
                        
                        if (updateResult.rows && updateResult.rows.length > 0) {
                            const { owner_id, mac } = updateResult.rows[0];
                            this.logger.info({ command_id: commandId, new_version: newVersion }, 'Command timed out and updated to timeout status');
                            
                            // Delete timed-out command from active_commands collection
                            if (this.mongoDb) {
                                await this.mongoDb.collection('active_commands').deleteOne({ _id: commandId }).catch(err => {
                                    this.logger.error({ err, commandId }, 'Failed to delete active command from MongoDB on timeout');
                                });
                            }

                            try {
                                await this.redis.publish(REDIS_CHANNELS.DEVICE_COMMAND, JSON.stringify({
                                    owner_id,
                                    mac,
                                    payload: {
                                        command_id: commandId,
                                        status: COMMAND_STATUS.TIMEOUT,
                                        event_version: newVersion,
                                        error_log: 'ACK timeout exceeded'
                                    },
                                    timestamp: new Date().toISOString()
                                }));
                            } catch (pubErr) {
                                this.logger.warn({ pubErr, commandId }, 'Failed to publish timeout update to Redis Pub/Sub');
                            }
                        }
                    } catch (cmdErr) {
                        this.logger.error({ cmdErr, commandId }, 'Failed to process timeout transition for command');
                    }
                }
            } catch (err) {
                this.logger.error({ err }, 'Failed to check command timeouts in PostgreSQL');
            }
        }, intervalMs);
    }

    private async runConsumerLoop(streamKey: string, groupName: string) {
        while (this.isRunning) {
            try {
                // XREADGROUP GROUP <group> <consumer> BLOCK 5000 COUNT 10 STREAMS <key> >
                const messages: any = await this.redis.call(
                    'XREADGROUP',
                    'GROUP',
                    groupName,
                    this.consumerName,
                    'BLOCK',
                    5000,
                    'COUNT',
                    10,
                    'STREAMS',
                    streamKey,
                    '>'
                );

                if (!messages || messages.length === 0) {
                    continue;
                }

                const [, commandMessages] = messages[0];
                for (const [messageId, messageFields] of commandMessages) {
                    await this.processMessage(messageId, messageFields, streamKey, groupName);
                }
            } catch (err: any) {
                this.logger.error({ err }, 'Error in command status consumer loop');
                if (err.message && err.message.includes('NOGROUP')) {
                    this.logger.warn('NOGROUP error detected (Redis restart). Re-creating consumer group...');
                    try {
                        await this.redis.call('XGROUP', 'CREATE', streamKey, groupName, '$', 'MKSTREAM');
                        this.logger.info(`Re-created consumer group ${groupName} for stream ${streamKey}`);
                    } catch (initErr: any) {
                        if (!initErr.message.includes('BUSYGROUP')) {
                            this.logger.error({ err: initErr }, 'Failed to re-create consumer group after NOGROUP');
                        }
                    }
                }
                // Nghỉ 2 giây trước khi thử lại nếu lỗi
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    }

    private async processMessage(messageId: string, messageFields: string[], streamKey: string, groupName: string) {
        try {
            const payload: any = {};
            for (let i = 0; i < messageFields.length; i += 2) {
                const key = messageFields[i];
                const value = messageFields[i + 1];
                if (key === 'data') {
                    Object.assign(payload, JSON.parse(value));
                } else {
                    payload[key] = value;
                }
            }

            const { command_id, status, error_log, retry_count, event_version } = payload;
            if (!command_id || !status || event_version === undefined) {
                this.logger.warn({ messageId, payload }, 'Received invalid status sync message, ACKing to clear stream');
                await this.redis.call('XACK', streamKey, groupName, messageId);
                return;
            }

            // Cập nhật PostgreSQL kiểm tra event_version và tránh ghi đè trạng thái cuối
            const query = `
                UPDATE device_commands
                SET 
                    status = $1, 
                    event_version = $2,
                    retry_count = COALESCE($3, retry_count),
                    error_log = COALESCE($4, error_log),
                    updated_at = NOW()
                WHERE id = $5
                  AND $2 > event_version
                  AND status NOT IN ('${COMMAND_STATUS.ACKED}', '${COMMAND_STATUS.FAILED}', '${COMMAND_STATUS.TIMEOUT}')
                RETURNING owner_id, mac
            `;
            const result = await this.pgPool.query(query, [
                status,
                Number(event_version),
                retry_count !== undefined && retry_count !== null ? Number(retry_count) : null,
                error_log || null,
                command_id
            ]);
            
            if (result.rows && result.rows.length > 0) {
                const { owner_id, mac } = result.rows[0];
                this.logger.debug({ command_id, status, event_version }, 'Command status updated in PostgreSQL');
                
                // Sync to MongoDB active_commands collection
                if (this.mongoDb) {
                    if (status === COMMAND_STATUS.ACKED || status === COMMAND_STATUS.FAILED) {
                        await this.mongoDb.collection('active_commands').deleteOne({ _id: command_id }).catch(err => {
                            this.logger.error({ err, command_id }, 'Failed to delete active command from MongoDB');
                        });
                    } else if (status === COMMAND_STATUS.SENDING || status === COMMAND_STATUS.SENT) {
                        await this.mongoDb.collection('active_commands').updateOne(
                            { _id: command_id, event_version: { $lt: Number(event_version) } },
                            {
                                $set: {
                                    status,
                                    event_version: Number(event_version),
                                    updated_at: new Date()
                                }
                            },
                            { upsert: true }
                        ).catch(err => {
                            this.logger.error({ err, command_id }, 'Failed to update active command in MongoDB');
                        });
                    }
                }

                try {
                    await this.redis.publish(REDIS_CHANNELS.DEVICE_COMMAND, JSON.stringify({
                        owner_id,
                        mac,
                        payload: {
                            command_id,
                            status,
                            event_version: Number(event_version),
                            error_log: error_log || null
                        },
                        timestamp: new Date().toISOString()
                    }));
                } catch (pubErr) {
                    this.logger.warn({ pubErr, command_id }, 'Failed to publish command update to Redis Pub/Sub');
                }
            } else {
                this.logger.debug({ command_id, status, event_version }, 'Command status update ignored (out-of-order, duplicate or terminal state)');
            }

            // ACK trên Redis Stream
            await this.redis.call('XACK', streamKey, groupName, messageId);
        } catch (err) {
            this.logger.error({ err, messageId }, 'Failed to process command status update message');
            // Không ACK để có thể được xử lý lại sau
        }
    }

    async stop() {
        this.isRunning = false;
        if (this.timeoutTimer) {
            clearInterval(this.timeoutTimer);
            this.timeoutTimer = null;
        }
        this.logger.info('Stopped CommandStatusConsumer.');
    }
}
