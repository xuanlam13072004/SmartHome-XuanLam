'use strict';

const { processCredential, updateCredentialStatus } = require('../services/credentialProcessor');
const { ensureConsumerGroup, parseMessage } = require('./operationConsumer');

async function handleCredentialMessage(clients, config, logger, messageId, fields) {
    let message;
    try {
        message = parseMessage(fields);
        await processCredential(message, clients, config, logger);
        await clients.redis.call(
            'XACK', config.REDIS_CREDENTIAL_STREAM, config.REDIS_CREDENTIAL_GROUP, messageId,
        );
    } catch (error) {
        const jobId = message?.job_id;
        logger.error({ error, jobId, messageId }, 'Credential stream message failed');
        if (jobId) {
            await updateCredentialStatus(
                clients.redis, config, jobId, 'failed', 'CREDENTIAL_DELIVERY_FAILED',
            );
        }
        await clients.redis.call(
            'XACK', config.REDIS_CREDENTIAL_STREAM, config.REDIS_CREDENTIAL_GROUP, messageId,
        );
    }
}

async function startCredentialConsumer(clients, config, logger) {
    await ensureConsumerGroup(
        clients.redis, config.REDIS_CREDENTIAL_STREAM,
        config.REDIS_CREDENTIAL_GROUP, logger,
    );
    while (true) {
        const messages = await clients.redis.call(
            'XREADGROUP', 'GROUP', config.REDIS_CREDENTIAL_GROUP,
            config.REDIS_CREDENTIAL_CONSUMER, 'BLOCK', 5000, 'COUNT', 20,
            'STREAMS', config.REDIS_CREDENTIAL_STREAM, '>',
        );
        if (!messages) continue;
        for (const [messageId, fields] of messages[0][1]) {
            await handleCredentialMessage(clients, config, logger, messageId, fields);
        }
    }
}

module.exports = { handleCredentialMessage, startCredentialConsumer };
