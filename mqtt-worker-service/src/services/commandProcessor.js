/**
 * Tác dụng của file này:
 * - Xử lý vòng đời của lệnh điều khiển (ON/OFF device)
 * - Nhận lệnh từ Redis Stream (device.commands)
 * - Validate + resolve owner/device
 * - Publish lệnh xuống MQTT (topic phẳng)
 * - Đẩy trạng thái lệnh (sent/failed) lên Redis Stream để API Gateway đồng bộ về PostgreSQL
 */

const { z } = require('zod');
const { recordCommandSuccess, recordCommandFailure } = require('../monitoring/metrics');

/**
 * Schema validate cho command message từ Redis
 */
const commandSchema = z.object({
    command_id: z.string().uuid(),
    owner_id: z.string().uuid(),
    device_id: z.string(), // MAC address
    capability_id: z.string().min(1).max(64),
    action: z.string().min(1).max(64),
    instance: z.string().min(1).max(64),
    payload: z.record(z.any()).optional(),
    timestamp: z.string().datetime().optional(),
});

/**
 * validateCommand: kiểm tra message có đúng schema không
 */
function validateCommand(message) {
    return commandSchema.parse(message);
}

/**
 * publishCommandToDevice: gửi lệnh xuống MQTT
 */
function publishCommandToDevice(mqttClient, command, config, logger) {
    // Tạo topic theo template phẳng: smarthome/{device_id}/control
    const topic = config.MQTT_CONTROL_TOPIC
        .replace('{device_id}', command.device_id);

    // Tạo payload lệnh
    const payload = {
        command_id: command.command_id,
        capability_id: command.capability_id,
        action: command.action,
        instance: command.instance,
        timestamp: new Date().toISOString(),
        ...(command.payload && { payload: command.payload }),
    };

    logger.debug(
        { topic, command_id: command.command_id, action: command.action },
        'Publishing command to MQTT'
    );

    return new Promise((resolve, reject) => {
        mqttClient.publish(
            topic,
            JSON.stringify(payload),
            { qos: config.MQTT_QOS },
            (err) => {
                if (err) {
                    logger.error({ err, command_id: command.command_id }, 'MQTT publish failed');
                    reject(err);
                } else {
                    logger.info({ command_id: command.command_id }, 'Command published to MQTT');
                    resolve();
                }
            }
        );
    });
}

/**
 * updateCommandStatus: đẩy sự kiện cập nhật trạng thái lên Redis Stream để API Gateway đồng bộ về PostgreSQL
 * 
 * @param {object} redis - Redis client
 * @param {object} config - biến config
 * @param {string} commandId - command UUID
 * @param {string} status - trạng thái mới (sending, sent, acked, failed, timeout)
 * @param {string} errorMessage - tin nhắn lỗi nếu có
 * @param {object} logger - logger instance
 * @param {number|null} retryCount - số lần retry của command
 */
async function updateCommandStatus(redis, config, commandId, status, errorMessage = null, logger, retryCount = null) {
    try {
        const lockKey = `command_lock:${commandId}`;

        // Kiểm tra Idempotent ACK chống duplicate hoặc late ACK
        if (status === 'acked' || status === 'failed') {
            const currentLockVal = await redis.get(lockKey);
            if (currentLockVal === 'timeout') {
                logger.warn({ command_id: commandId, status }, 'updateCommandStatus: Late ACK/Response ignored because command already timed out');
                return;
            }
            if (currentLockVal === 'acked' || currentLockVal === 'failed') {
                logger.info({ command_id: commandId, status }, 'updateCommandStatus: Duplicate ACK/Response ignored');
                return;
            }
        }

        // Sinh event_version tăng dần thông qua Redis INCR
        const versionKey = `command_version:${commandId}`;
        const eventVersion = await redis.incr(versionKey);
        if (eventVersion === 1) {
            await redis.expire(versionKey, 600); // TTL 10 phút
        }

        // Ghi nhận trạng thái tạm thời trong Redis để theo dõi nhanh
        await redis.set(lockKey, status, 'EX', 60); // Lưu giữ trạng thái trong 60 giây

        const payload = {
            command_id: commandId,
            status,
            error_log: errorMessage || '',
            event_version: eventVersion,
            ...(retryCount !== null && { retry_count: retryCount }),
        };

        // Đẩy vào Redis Stream `command.status.stream` để sync về Postgres không đồng bộ
        await redis.xadd(
            config.REDIS_COMMAND_STATUS_STREAM,
            '*',
            'data',
            JSON.stringify(payload)
        );

        logger.debug({ command_id: commandId, status, retry_count: retryCount, event_version: eventVersion }, 'Command status update published to Redis Stream');
    } catch (err) {
        logger.error(
            { err, command_id: commandId, status },
            'Failed to publish command status update'
        );
        throw err;
    }
}

/**
 * tryAcquireCommand: chuyển trạng thái từ pending -> sending một cách atomic sử dụng Redis locks (SET NX)
 * 
 * @param {object} redis - Redis client
 * @param {string} commandId - command UUID
 * @param {object} logger - logger instance
 * @returns {Promise<boolean>} true nếu acquire được, false nếu đã có worker khác xử lý
 */
async function tryAcquireCommand(redis, commandId, logger) {
    try {
        const lockKey = `command_lock:${commandId}`;
        
        // Sử dụng SET NX để tạo lock nguyên tử trong 10 giây (tránh bị kẹt mãi mãi nếu crash)
        const result = await redis.set(lockKey, 'sending', 'EX', 10, 'NX');

        if (result !== 'OK') {
            logger.info({ command_id: commandId }, 'Command already acquired by another worker');
            return false;
        }

        return true;
    } catch (err) {
        logger.error({ err, command_id: commandId }, 'Failed to acquire command lock via Redis');
        throw err;
    }
}

/**
 * processCommand: luồng xử lý chính cho 1 lệnh
 * 
 * @param {object} rawMessage - message từ Redis
 * @param {object} clients - { mqttClient, redis }
 * @param {object} config - biến môi trường
 * @param {object} logger - logger instance
 * @param {number|null} retryCount - số lần retry của command
 * @returns {Promise<string>} command_id đã xử lý
 */
async function processCommand(rawMessage, clients, config, logger, retryCount = null) {
    let command;

    // Bước 1: Validate schema
    try {
        command = validateCommand(rawMessage);
    } catch (err) {
        logger.error({ err, message: rawMessage }, 'Invalid command schema');
        throw new Error(`Schema validation failed: ${err.message}`);
    }

    const { command_id, action, device_id } = command;

    // Bước 1.5: Idempotency atomic - chỉ worker nào acquire được lock mới xử lý
    const acquired = await tryAcquireCommand(clients.redis, command_id, logger);

    if (!acquired) {
        return command_id;
    }

    // Gửi sự kiện 'sending' về stream cập nhật
    try {
        await updateCommandStatus(clients.redis, config, command_id, 'sending', null, logger, retryCount);
    } catch (err) {
        logger.warn({ err, command_id }, 'Failed to update sending status, continuing execution');
    }

    try {
        // Bước 2: Publish xuống MQTT
        await publishCommandToDevice(clients.mqttClient, command, config, logger);

        // Bước 3: Update status = sent
        await updateCommandStatus(clients.redis, config, command_id, 'sent', null, logger, retryCount);

        try { recordCommandSuccess(); } catch (mErr) {}
        logger.info({ command_id, device_id, action }, 'Command processed successfully');
        return command_id;
    } catch (err) {
        try { recordCommandFailure(); } catch (mErr) {}
        // Nếu lỗi, update status = failed
        try {
            await updateCommandStatus(clients.redis, config, command_id, 'failed', err.message, logger, retryCount);
        } catch (updateErr) {
            logger.error({ updateErr }, 'Failed to update error status');
        }

        throw err;
    }
}

module.exports = {
    validateCommand,
    publishCommandToDevice,
    updateCommandStatus,
    tryAcquireCommand,
    processCommand,
};
