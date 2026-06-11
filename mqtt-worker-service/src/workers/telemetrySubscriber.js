/**
 * Tác dụng của file này:
 * - Subscribe MQTT topics để nhận telemetry từ ESP32
 * - Parse + validate message
 * - Gọi processTelemetry để ghi Mongo + phát realtime
 * - Xử lý ACK lệnh từ thiết bị
 *
 * Luồng xử lý:
 * ESP32 publish -> MQTT Broker
 *   -> Subscriber nhận message
 *   -> Parse JSON payload
 *   -> Gọi processTelemetry
 *   -> Ghi MongoDB + push Redis realtime
 *   -> ACK nếu cần
 */

const { processTelemetry } = require('../services/telemetryProcessor');
const { updateCommandStatus } = require('../services/commandProcessor');

/**
 * subscribeToTelemetry: setup subscription cho MQTT telemetry topics
 * 
 * Luồng:
 * 1. Subscribe topic template: smarthome/+/+/telemetry
 *    +/+ = wildcard cho owner_id và device_id
 * 2. Gắn listener 'message'
 * 3. Khi nhận message, parse + xử lý
 * 4. Log subscribe thành công
 * 
 * @param {object} mqttClient - MQTT client instance
 * @param {object} config - biến config (topic template)
 * @param {object} logger - logger instance
 * @returns {Promise}
 */
async function subscribeToTelemetry(mqttClient, config, logger) {
    return new Promise((resolve, reject) => {
        const sharedPrefix = config.MQTT_SHARED_GROUP
            ? `$share/${config.MQTT_SHARED_GROUP}/`
            : '';
        const telemetryTopic = `${sharedPrefix}${config.MQTT_TELEMETRY_TOPIC}`;

        logger.info({ topic: telemetryTopic }, 'Subscribing to telemetry topic');

        mqttClient.subscribe(telemetryTopic, { qos: 1 }, (err) => {
            if (err) {
                logger.error({ err, topic: telemetryTopic }, 'Failed to subscribe to telemetry topic');
                reject(err);
            } else {
                logger.info({ topic: telemetryTopic }, 'Subscribed to telemetry topic');
                resolve();
            }
        });
    });
}

/**
 * subscribeToAck: setup subscription cho MQTT ACK topics
 * 
 * Luồng:
 * 1. Subscribe topic: smarthome/+/+/ack
 *    Thiết bị sẽ publish ACK khi nhận được lệnh control
 * 2. Khi nhận ACK, extract command_id + device_id
 * 3. Update device_commands status = acked
 * 4. Log ACK thành công
 * 
 * @param {object} mqttClient - MQTT client instance
 * @param {object} config - biến config (topic template)
 * @param {object} logger - logger instance
 * @returns {Promise}
 */
async function subscribeToAck(mqttClient, config, logger) {
    return new Promise((resolve, reject) => {
        const sharedPrefix = config.MQTT_SHARED_GROUP
            ? `$share/${config.MQTT_SHARED_GROUP}/`
            : '';
        const ackTopic = `${sharedPrefix}${config.MQTT_ACK_TOPIC}`;

        logger.info({ topic: ackTopic }, 'Subscribing to ACK topic');

        mqttClient.subscribe(ackTopic, { qos: 1 }, (err) => {
            if (err) {
                logger.error({ err, topic: ackTopic }, 'Failed to subscribe to ACK topic');
                reject(err);
            } else {
                logger.info({ topic: ackTopic }, 'Subscribed to ACK topic');
                resolve();
            }
        });
    });
}

/**
 * handleTelemetryMessage: xử lý 1 message telemetry từ MQTT
 * 
 * Bước:
 * 1. Parse JSON payload
 * 2. Gọi processTelemetry từ telemetryProcessor
 * 3. Log kết quả
 * 4. Nếu lỗi, log error nhưng không crash
 * 
 * @param {string} topic - MQTT topic
 * @param {Buffer} payload - message payload (JSON)
 * @param {object} clients - { redis, pgPool, mongoClient, mqttClient }
 * @param {object} config - biến config
 * @param {object} logger - logger instance
 * @returns {Promise}
 */
async function handleTelemetryMessage(topic, payload, clients, config, logger) {
    try {
        const message = JSON.parse(payload.toString());

        logger.debug({ topic, device_id: message.device_id }, 'Received telemetry message');

        await processTelemetry(message, clients, config, logger);
    } catch (err) {
        logger.error({ err, topic }, 'Failed to process telemetry message');
        // Không throw - telemetry loss không critical như command loss
    }
}

/**
 * handleAckMessage: xử lý 1 message ACK từ thiết bị
 * 
 * ACK format:
 * {
 *   "command_id": "uuid-xxx",
 *   "device_id": "AA:BB:CC:01",
 *   "status": "success" hoặc "error",
 *   "error_msg": "lý do nếu error"
 * }
 * 
 * Bước:
 * 1. Parse JSON
 * 2. Validate command_id
 * 3. Đẩy tin nhắn cập nhật trạng thái (acked/failed) vào Redis Stream command.status.stream
 * 4. Log ACK
 * 
 * @param {string} topic - MQTT topic
 * @param {Buffer} payload - message payload (JSON)
 * @param {object} clients - { redis }
 * @param {object} config - cấu hình
 * @param {object} logger - logger instance
 * @returns {Promise}
 */
async function handleAckMessage(topic, payload, clients, config, logger) {
    try {
        const ack = JSON.parse(payload.toString());
        const { command_id, device_id, status, error_msg } = ack;

        if (!command_id) {
            logger.warn({ topic }, 'ACK message missing command_id');
            return;
        }

        logger.debug({ command_id, device_id, status }, 'Received ACK message');

        // Update command status
        const commandStatus = status === 'success' ? 'acked' : 'failed';
        const errorMsg = status === 'success' ? null : error_msg || 'Device returned error';

        // Đẩy sự kiện qua Redis Stream thay vì chọc trực tiếp vào PostgreSQL
        await updateCommandStatus(clients.redis, config, command_id, commandStatus, errorMsg, logger);

        logger.info({ command_id, device_id }, 'Command ACK processed');
    } catch (err) {
        logger.error({ err, topic }, 'Failed to process ACK message');
        // Không throw
    }
}

/**
 * setupMessageHandlers: gắn event handler cho MQTT message
 * 
 * Luồng:
 * 1. Gắn listener 'message' event
 * 2. Khi MQTT message đến, kiểm tra topic
 * 3. Nếu telemetry topic -> handleTelemetryMessage
 * 4. Nếu ACK topic -> handleAckMessage
 * 5. Nếu topic không khớp -> ignore (không phải lỗi)
 * 
 * @param {object} mqttClient - MQTT client instance
 * @param {object} clients - { redis, mongoClient, mqttClient }
 * @param {object} config - biến config
 * @param {object} logger - logger instance
 */
function setupMessageHandlers(mqttClient, clients, config, logger) {
    mqttClient.on('message', async (topic, payload) => {
        // Kiểm tra topic
        const cleanTopic = topic.startsWith('$share/')
            ? topic.split('/').slice(2).join('/')
            : topic;
        const telemetryPattern = config.MQTT_TELEMETRY_TOPIC.replace(/\+/g, '[^/]+');
        const ackPattern = config.MQTT_ACK_TOPIC.replace(/\+/g, '[^/]+');
        const telemetryRegex = new RegExp(`^${telemetryPattern}$`);
        const ackRegex = new RegExp(`^${ackPattern}$`);

        if (telemetryRegex.test(cleanTopic)) {
            await handleTelemetryMessage(cleanTopic, payload, clients, config, logger);
        } else if (ackRegex.test(cleanTopic)) {
            await handleAckMessage(cleanTopic, payload, clients, config, logger);
        }
        // Ignore topic không khớp
    });
}

/**
 * startTelemetrySubscriber: setup toàn bộ telemetry subscription
 * 
 * Bước:
 * 1. Subscribe telemetry topic
 * 2. Subscribe ACK topic
 * 3. Setup message handlers
 * 4. Log subscribe thành công
 * 
 * @param {object} mqttClient - MQTT client instance
 * @param {object} clients - { redis, mongoClient, mqttClient }
 * @param {object} config - biến config
 * @param {object} logger - logger instance
 * @returns {Promise}
 */
async function startTelemetrySubscriber(mqttClient, clients, config, logger) {
    logger.info('Starting telemetry subscriber');

    try {
        await subscribeToTelemetry(mqttClient, config, logger);
        await subscribeToAck(mqttClient, config, logger);
        setupMessageHandlers(mqttClient, clients, config, logger);

        logger.info('Telemetry subscriber ready');
    } catch (err) {
        logger.error({ err }, 'Failed to start telemetry subscriber');
        throw err;
    }
}

module.exports = {
    startTelemetrySubscriber,
};
