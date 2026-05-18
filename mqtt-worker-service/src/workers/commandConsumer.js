/**
 * Tác dụng của file này:
 * - Vòng lặp chính để đọc lệnh từ Redis Stream (device.commands)
 * - Xử lý từng lệnh theo thứ tự (FIFO)
 * - Quản lý consumer group + ACK
 * - Xử lý timeout + retry
 * - Đảm bảo không mất lệnh ngay cả khi worker crash
 *
 * Redis Streams + Consumer Groups:
 * - Stream: device.commands
 * - Consumer Group: mqtt-worker-group
 * - Consumer: worker-1 (có thể scale thêm worker-2, worker-3)
 * - ACK: chỉ xóa message khỏi pending khi xử lý thành công
 * - Idle: nếu worker crash, message quay lại được consumer khác pick up
 */

const { processCommand } = require('../services/commandProcessor');

/**
 * initConsumerGroup: tạo consumer group nếu chưa tồn tại
 * 
 * Mục đích:
 * - Đảm bảo group tồn tại trước khi consumer join
 * - Nếu group đã tồn tại, ignore error
 * - $ = start từ message mới nhất (không reprocess lịch sử)
 * 
 * @param {object} redis - Redis client
 * @param {string} streamKey - tên stream (device.commands)
 * @param {string} groupName - tên consumer group
 * @param {object} logger - logger instance
 */
async function initConsumerGroup(redis, streamKey, groupName, logger) {
    try {
        // Tạo consumer group
        // XGROUP CREATE <stream> <group> <id> [MKSTREAM]
        // <id> = $: chỉ read message mới từ lúc create group
        // MKSTREAM: tự tạo stream nếu chưa tồn tại
        await redis.call('XGROUP', 'CREATE', streamKey, groupName, '$', 'MKSTREAM');
        logger.info({ stream: streamKey, group: groupName }, 'Consumer group created');
    } catch (err) {
        // BUSYGROUP = group đã tồn tại, bình thường
        if (err.message.includes('BUSYGROUP')) {
            logger.debug({ stream: streamKey, group: groupName }, 'Consumer group already exists');
        } else {
            logger.error({ err, stream: streamKey, group: groupName }, 'Failed to create consumer group');
            throw err;
        }
    }
}

/**
 * readCommandBatch: đọc batch lệnh từ stream
 * 
 * Luồng:
 * 1. XREADGROUP từ stream theo consumer group
 * 2. BLOCK 5000ms = chờ 5 giây nếu không có message mới
 * 3. COUNT 10 = mỗi lần đọc tối đa 10 message
 * 4. >: chỉ đọc message chưa assign cho consumer nào
 * 
 * @param {object} redis - Redis client
 * @param {string} streamKey - tên stream
 * @param {string} groupName - tên consumer group
 * @param {string} consumerName - tên consumer (worker-1)
 * @param {object} logger - logger instance
 * @returns {Promise<array>} mảng [streamKey, [message_id, message_data]]
 */
async function readCommandBatch(redis, streamKey, groupName, consumerName, logger) {
    try {
        // XREADGROUP GROUP <group> <consumer> BLOCK <ms> COUNT <n> STREAMS <key> >
        const messages = await redis.call(
            'XREADGROUP',
            'GROUP',
            groupName,
            consumerName,
            'BLOCK',
            5000,
            'COUNT',
            10,
            'STREAMS',
            streamKey,
            '>'
        );

        if (!messages || messages.length === 0) {
            return [];
        }

        // messages = [[streamKey, [[id1, data1], [id2, data2], ...]]]
        return messages;
    } catch (err) {
        logger.error({ err, stream: streamKey }, 'Failed to read from stream');
        throw err;
    }
}

/**
 * reclaimPendingMessages: lấy lại message bị kẹt trong Pending Entries List
 * 
 * Dùng XAUTOCLAIM để tự động claim message idle quá lâu
 * 
 * @param {object} redis - Redis client
 * @param {string} streamKey - tên stream
 * @param {string} groupName - tên consumer group
 * @param {string} consumerName - tên consumer hiện tại
 * @param {number} idleMs - thời gian idle tối thiểu để reclaim
 * @param {number} count - số message reclaim tối đa mỗi lần
 * @param {object} logger - logger instance
 * @returns {Promise<array>} danh sách message reclaimed
 */
async function reclaimPendingMessages(redis, streamKey, groupName, consumerName, idleMs, count, logger) {
    try {
        // XAUTOCLAIM <key> <group> <consumer> <min-idle-time> <start-id> COUNT <n>
        const result = await redis.call(
            'XAUTOCLAIM',
            streamKey,
            groupName,
            consumerName,
            idleMs,
            '0-0',
            'COUNT',
            count
        );

        if (!result || result.length < 2) return [];

        const reclaimed = result[1]; // [[id, fields], [id, fields], ...]

        if (reclaimed.length > 0) {
            logger.warn({ reclaimed: reclaimed.length }, 'Reclaimed pending messages');
        }

        return reclaimed;
    } catch (err) {
        logger.error({ err }, 'Failed to reclaim pending messages');
        return [];
    }
}

/**
 * startReclaimLoop: vòng lặp reclaim riêng (ưu tiên xử lý pending)
 * 
 * Chạy định kỳ theo REDIS_CLAIM_INTERVAL_MS
 * Tách khỏi loop đọc message mới để tránh starvation và dễ quan sát
 * 
 * @param {object} clients - { redis, mqttClient, pgPool, mongoClient }
 * @param {string} streamKey - tên stream
 * @param {string} groupName - tên consumer group
 * @param {string} consumerName - tên consumer
 * @param {object} config - biến config
 * @param {object} logger - logger instance
 */
function startReclaimLoop(clients, streamKey, groupName, consumerName, config, logger) {
    const interval = config.REDIS_CLAIM_INTERVAL_MS;

    return setInterval(async () => {
        try {
            const reclaimed = await reclaimPendingMessages(
                clients.redis,
                streamKey,
                groupName,
                consumerName,
                config.REDIS_CLAIM_IDLE_MS,
                config.REDIS_CLAIM_COUNT,
                logger
            );

            for (const [messageId, messageData] of reclaimed) {
                await processCommandMessage(
                    clients.redis,
                    streamKey,
                    groupName,
                    messageId,
                    messageData,
                    clients,
                    config,
                    logger
                );
            }
        } catch (err) {
            logger.error({ err }, 'Reclaim loop error');
        }
    }, interval);
}

/**
 * processCommandMessage: xử lý 1 message command
 * 
 * Bước:
 * 1. Parse JSON từ Redis message
 * 2. Gọi processCommand từ commandProcessor
 * 3. ACK message nếu thành công
 * 4. Nếu lỗi, log + không ACK (message sẽ vào pending cho retry)
 * 
 * @param {object} redis - Redis client
 * @param {string} streamKey - tên stream
 * @param {string} groupName - consumer group
 * @param {string} messageId - message ID từ Redis
 * @param {array} messageData - [field1, value1, field2, value2, ...]
 * @param {object} clients - { mqttClient, pgPool, mongoClient }
 * @param {object} config - biến config
 * @param {object} logger - logger instance
 * @returns {Promise<boolean>} true nếu thành công & ACK được, false nếu lỗi
 */
async function processCommandMessage(
    redis,
    streamKey,
    groupName,
    messageId,
    messageData,
    clients,
    config,
    logger
) {
    try {
        // Parse message data từ Redis format [field1, value1, field2, value2, ...]
        const message = {};
        for (let i = 0; i < messageData.length; i += 2) {
            const field = messageData[i];
            const value = messageData[i + 1];

            // Nếu field là 'data', parse JSON
            if (field === 'data') {
                message.data = JSON.parse(value);
                Object.assign(message, message.data);
                delete message.data;
            } else {
                message[field] = value;
            }
        }

        logger.debug({ message_id: messageId, command_id: message.command_id }, 'Processing command');

        // Retry limit check
        const retryResult = await clients.pgPool.query(
            'SELECT retry_count FROM device_commands WHERE id = $1',
            [message.command_id]
        );

        if (retryResult.rows.length === 0) {
            logger.warn({ command_id: message.command_id }, 'Command not found, ACKing message');
            await redis.call('XACK', streamKey, groupName, messageId);
            return true;
        }

        const retryCount = retryResult.rows[0].retry_count || 0;

        if (retryCount >= config.COMMAND_MAX_RETRY) {
            await clients.pgPool.query(
                `
                UPDATE device_commands
                SET status = 'failed', updated_at = NOW(), error_log = $2
                WHERE id = $1
              `,
                [message.command_id, 'Retry limit exceeded']
            );

            await redis.call('XACK', streamKey, groupName, messageId);
            logger.warn({ command_id: message.command_id, retry_count: retryCount }, 'Retry limit reached, ACKing');
            return true;
        }

        // Increment retry_count before processing
        await clients.pgPool.query(
            'UPDATE device_commands SET retry_count = retry_count + 1 WHERE id = $1',
            [message.command_id]
        );

        // Gọi processCommand từ commandProcessor
        await processCommand(message, clients, config, logger);

        // Nếu thành công, ACK message
        // XACK <stream> <group> <id1> [id2 ...]
        await redis.call('XACK', streamKey, groupName, messageId);
        logger.debug({ message_id: messageId }, 'Command ACKed');

        return true;
    } catch (err) {
        logger.error(
            { err, message_id: messageId, command_id: messageData.command_id },
            'Failed to process command message'
        );
        // Không ACK = message vẫn trong pending, sẽ retry sau
        return false;
    }
}

/**
 * startCommandConsumer: vòng lặp chính để tiêu thụ lệnh
 * 
 * Luồng:
 * 1. Init consumer group
 * 2. Loop vô tận:
 *    a. Đọc batch lệnh từ stream
 *    b. Xử lý từng lệnh
 *    c. Log kết quả
 * 3. Nếu lỗi, log + continue (không crash)
 * 
 * @param {object} clients - { redis, mqttClient, pgPool, mongoClient }
 * @param {object} config - biến config
 * @param {object} logger - logger instance
 */
async function startCommandConsumer(clients, config, logger) {
    const streamKey = config.REDIS_COMMAND_STREAM;
    const groupName = config.REDIS_COMMAND_GROUP;
    const consumerName = config.REDIS_COMMAND_CONSUMER;

    logger.info({ stream: streamKey, group: groupName, consumer: consumerName }, 'Starting command consumer');

    try {
        // Bước 1: Init consumer group
        await initConsumerGroup(clients.redis, streamKey, groupName, logger);
    } catch (err) {
        logger.error({ err }, 'Failed to init consumer group');
        throw err;
    }

    // Bước 2: Start reclaim loop riêng
    const reclaimTimer = startReclaimLoop(
        clients,
        streamKey,
        groupName,
        consumerName,
        config,
        logger
    );

    // Bước 3: Vòng lặp chính
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 10; // Nếu lỗi liên tiếp 10 lần thì bỏ cuộc

    while (true) {
        try {
            // Đọc batch lệnh
            const messages = await readCommandBatch(
                clients.redis,
                streamKey,
                groupName,
                consumerName,
                logger
            );

            // Nếu không có message, continue
            if (messages.length === 0) {
                consecutiveErrors = 0; // Reset error counter nếu read thành công
                continue;
            }

            // Xử lý từng message
            const [, commandMessages] = messages[0];
            let successCount = 0;
            let failCount = 0;

            for (const [messageId, messageData] of commandMessages) {
                const processed = await processCommandMessage(
                    clients.redis,
                    streamKey,
                    groupName,
                    messageId,
                    messageData,
                    clients,
                    config,
                    logger
                );

                if (processed) {
                    successCount++;
                } else {
                    failCount++;
                }
            }

            if (successCount > 0 || failCount > 0) {
                logger.info(
                    { batch_size: commandMessages.length, success: successCount, failed: failCount },
                    'Command batch processed'
                );
            }

            consecutiveErrors = 0;
        } catch (err) {
            consecutiveErrors++;
            logger.error(
                { err, consecutive_errors: consecutiveErrors },
                'Command consumer error'
            );

            // Nếu lỗi quá nhiều lần, thoát để trigger health check
            if (consecutiveErrors >= maxConsecutiveErrors) {
                logger.fatal({ consecutive_errors: consecutiveErrors }, 'Command consumer giving up');
                clearInterval(reclaimTimer);
                throw new Error('Command consumer exceeded max consecutive errors');
            }

            // Chờ 1 giây trước retry
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

module.exports = {
    startCommandConsumer,
};
