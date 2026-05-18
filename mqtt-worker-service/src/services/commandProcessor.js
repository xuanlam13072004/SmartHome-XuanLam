/**
 * Tác dụng của file này:
 * - Xử lý vòng đời của lệnh điều khiển (ON/OFF device)
 * - Nhận lệnh từ Redis Stream
 * - Validate + resolve owner/device
 * - Publish lệnh xuống MQTT
 * - Cập nhật trạng thái lệnh trong PostgreSQL
 *
 * Luồng xử lý:
 * API Service -> Redis Stream (device.commands) 
 *   -> Worker readCommand -> validate 
 *   -> publish MQTT 
 *   -> MQTT Worker wait ACK 
 *   -> updateCommandStatus (sent/acked/failed/timeout)
 */

const { z } = require('zod');

/**
 * Schema validate cho command message từ Redis
 * 
 * Mục đích:
 * - Đảm bảo message từ API có đủ thông tin
 * - Fail fast nếu thiếu field bắt buộc
 * - Dễ debug lỗi format message
 */
const commandSchema = z.object({
    command_id: z.string().uuid(),
    owner_id: z.string().uuid(),
    device_id: z.string(), // MAC address
    action: z.enum(['ON', 'OFF', 'SET_TEMP']),
    payload: z.record(z.any()).optional(),
    timestamp: z.string().datetime().optional(),
});

/**
 * validateCommand: kiểm tra message có đúng schema không
 * 
 * @param {object} message - raw message từ Redis
 * @returns {object} parsed message hoặc throw error
 */
function validateCommand(message) {
    return commandSchema.parse(message);
}

/**
 * publishCommandToDevice: gửi lệnh xuống MQTT
 * 
 * Luồng:
 * 1. Tạo topic MQTT từ owner_id + device_id
 * 2. Tạo payload lệnh
 * 3. Publish với QoS=1 (at least once)
 * 4. Trả về promise để theo dõi
 * 
 * @param {object} mqttClient - MQTT client instance
 * @param {object} command - validated command
 * @param {object} config - biến config (topic format, QoS)
 * @param {object} logger - logger instance
 * @returns {Promise}
 */
function publishCommandToDevice(mqttClient, command, config, logger) {
    // Tạo topic theo template: smarthome/{owner_id}/{device_id}/control
    const topic = config.MQTT_CONTROL_TOPIC
        .replace('{owner_id}', command.owner_id)
        .replace('{device_id}', command.device_id);

    // Tạo payload lệnh
    const payload = {
        command_id: command.command_id,
        action: command.action,
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
 * updateCommandStatus: cập nhật trạng thái lệnh trong PostgreSQL
 * 
 * Trạng thái có thể là:
 * - pending: lệnh vừa được tạo
 * - sent: lệnh đã gửi xuống MQTT
 * - acked: thiết bị đã nhận + xác nhận
 * - failed: thiết bị lỗi hoặc MQTT fail
 * - timeout: quá hạn chờ ACK
 * 
 * @param {object} pgPool - PostgreSQL pool
 * @param {string} commandId - command UUID
 * @param {string} status - trạng thái mới
 * @param {string} errorMessage - (optional) tin nhắn lỗi nếu có
 * @param {object} logger - logger instance
 * @returns {Promise}
 */
async function updateCommandStatus(pgPool, commandId, status, errorMessage = null, logger) {
    const query = `
    UPDATE device_commands
    SET 
      status = $1,
      updated_at = NOW(),
      error_log = $2
    WHERE id = $3
  `;

    try {
        await pgPool.query(query, [status, errorMessage, commandId]);
        logger.debug({ command_id: commandId, status }, 'Command status updated');
    } catch (err) {
        logger.error(
            { err, command_id: commandId, status },
            'Failed to update command status'
        );
        throw err;
    }
}

/**
 * tryAcquireCommand: chuyển trạng thái từ pending -> sending một cách atomic
 * 
 * @param {object} pgPool - PostgreSQL pool
 * @param {string} commandId - command UUID
 * @param {object} logger - logger instance
 * @returns {Promise<boolean>} true nếu acquire được, false nếu đã có worker khác xử lý
 */
async function tryAcquireCommand(pgPool, commandId, logger) {
    try {
        const result = await pgPool.query(
            `
            UPDATE device_commands
            SET status = 'sending', updated_at = NOW()
            WHERE id = $1 AND status = 'pending'
            RETURNING id
          `,
            [commandId]
        );

        if (result.rowCount === 0) {
            logger.info({ command_id: commandId }, 'Command already acquired or not pending');
            return false;
        }

        return true;
    } catch (err) {
        logger.error({ err, command_id: commandId }, 'Failed to acquire command');
        throw err;
    }
}

/**
 * processCommand: luồng xử lý chính cho 1 lệnh
 * 
 * Bước:
 * 1. Validate schema
 * 2. Publish MQTT
 * 3. Update status = sent
 * 4. Return command_id để worker tracking
 * 
 * @param {object} rawMessage - message từ Redis
 * @param {object} clients - { mqttClient, pgPool }
 * @param {object} config - biến môi trường
 * @param {object} logger - logger instance
 * @returns {Promise<string>} command_id đã xử lý
 */
async function processCommand(rawMessage, clients, config, logger) {
    let command;

    // Bước 1: Validate schema
    try {
        command = validateCommand(rawMessage);
    } catch (err) {
        logger.error({ err, message: rawMessage }, 'Invalid command schema');
        throw new Error(`Schema validation failed: ${err.message}`);
    }

    const { command_id, action, device_id } = command;

    // Bước 1.5: Idempotency atomic - chỉ worker nào acquire được mới publish
    const acquired = await tryAcquireCommand(clients.pgPool, command_id, logger);

    if (!acquired) {
        return command_id;
    }

    try {
        // Bước 2: Publish xuống MQTT
        await publishCommandToDevice(clients.mqttClient, command, config, logger);

        // Bước 3: Update status = sent
        await updateCommandStatus(clients.pgPool, command_id, 'sent', null, logger);

        logger.info({ command_id, device_id, action }, 'Command processed successfully');
        return command_id;
    } catch (err) {
        // Nếu lỗi, update status = failed
        try {
            await updateCommandStatus(clients.pgPool, command_id, 'failed', err.message, logger);
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
