'use strict';

const {
    processOperation,
    updateOperationStatus,
} = require('../services/operationProcessor');

async function ensureConsumerGroup(redis, stream, group, logger) {
    try {
        await redis.call('XGROUP', 'CREATE', stream, group, '0-0', 'MKSTREAM');
    } catch (error) {
        if (!String(error?.message).includes('BUSYGROUP')) throw error;
        logger.debug({ stream, group }, 'Operation consumer group already exists');
    }
}

function parseMessage(fields) {
    const message = {};
    for (let index = 0; index < fields.length; index += 2) {
        if (fields[index] === 'data') Object.assign(message, JSON.parse(fields[index + 1]));
        else message[fields[index]] = fields[index + 1];
    }
    return message;
}

async function handleMessage(clients, config, logger, messageId, fields) {
    let message;
    try {
        message = parseMessage(fields);
        await processOperation(message, clients, config, logger);
        await clients.redis.call(
            'XACK',
            config.REDIS_OPERATION_STREAM,
            config.REDIS_OPERATION_GROUP,
            messageId,
        );
        if (message.operation_id) {
            await clients.redis.del(`operation:failures:${message.operation_id}`);
        }
    } catch (error) {
        const operationId = message?.operation_id;
        logger.error({ error, operationId, messageId }, 'Operation stream message failed');
        if (!operationId) {
            await clients.redis.call(
                'XACK',
                config.REDIS_OPERATION_STREAM,
                config.REDIS_OPERATION_GROUP,
                messageId,
            );
            return;
        }
        const failures = await clients.redis.incr(`operation:failures:${operationId}`);
        await clients.redis.expire(
            `operation:failures:${operationId}`,
            config.OPERATION_IDEMPOTENCY_TTL_SECONDS,
        );
        if (failures > config.OPERATION_MAX_RETRY) {
            await updateOperationStatus(
                clients.redis,
                config,
                operationId,
                'failed',
                'OPERATION_DELIVERY_RETRY_EXHAUSTED',
                { error: String(error?.message || error) },
            );
            await clients.redis.call(
                'XACK',
                config.REDIS_OPERATION_STREAM,
                config.REDIS_OPERATION_GROUP,
                messageId,
            );
        }
    }
}

async function reclaim(clients, config, logger) {
    const result = await clients.redis.call(
        'XAUTOCLAIM',
        config.REDIS_OPERATION_STREAM,
        config.REDIS_OPERATION_GROUP,
        config.REDIS_OPERATION_CONSUMER,
        config.REDIS_CLAIM_IDLE_MS,
        '0-0',
        'COUNT',
        config.REDIS_CLAIM_COUNT,
    );
    for (const [messageId, fields] of result?.[1] || []) {
        await handleMessage(clients, config, logger, messageId, fields);
    }
}

async function startOperationConsumer(clients, config, logger) {
    await ensureConsumerGroup(
        clients.redis,
        config.REDIS_OPERATION_STREAM,
        config.REDIS_OPERATION_GROUP,
        logger,
    );
    let lastReclaim = 0;
    while (true) {
        if (Date.now() - lastReclaim >= config.REDIS_CLAIM_INTERVAL_MS) {
            await reclaim(clients, config, logger);
            lastReclaim = Date.now();
        }
        const messages = await clients.redis.call(
            'XREADGROUP',
            'GROUP',
            config.REDIS_OPERATION_GROUP,
            config.REDIS_OPERATION_CONSUMER,
            'BLOCK',
            5000,
            'COUNT',
            20,
            'STREAMS',
            config.REDIS_OPERATION_STREAM,
            '>',
        );
        if (!messages) continue;
        for (const [messageId, fields] of messages[0][1]) {
            await handleMessage(clients, config, logger, messageId, fields);
        }
    }
}

module.exports = {
    ensureConsumerGroup,
    handleMessage,
    parseMessage,
    reclaim,
    startOperationConsumer,
};
