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

const {
    processTelemetry,
    resolveDeviceContext,
} = require('../services/telemetryProcessor');
const { updateCommandStatus } = require('../services/commandProcessor');
const {
    validateCommandAck,
    validateTopologyAck,
    validateInboundTransport,
    markTopologyTransportOffline,
} = require('../services/topologyRuntime');
const {
    recordActivity,
    markDeviceOffline,
} = require('../services/presenceManager');
const { REDIS_CHANNELS } = require('../../../shared/constants');

function extractTopicOrigin(topic) {
    const parts = topic.split('/').filter(Boolean);
    return parts.length >= 2 ? parts[parts.length - 2].toUpperCase() : '';
}

function extractTopologyAckOrigin(topic) {
    const parts = topic.split('/').filter(Boolean);
    return parts.length >= 3 ? parts[parts.length - 3].toUpperCase() : '';
}

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

async function subscribeToTopologyAck(mqttClient, config, logger) {
    return new Promise((resolve, reject) => {
        const sharedPrefix = config.MQTT_SHARED_GROUP
            ? `$share/${config.MQTT_SHARED_GROUP}/`
            : '';
        const topic = `${sharedPrefix}${config.MQTT_TOPOLOGY_ACK_TOPIC}`;
        mqttClient.subscribe(topic, { qos: 1 }, (err) => {
            if (err) reject(err);
            else {
                logger.info({ topic }, 'Subscribed to topology ACK topic');
                resolve();
            }
        });
    });
}

async function subscribeToStatus(mqttClient, config, logger) {
    return new Promise((resolve, reject) => {
        const sharedPrefix = config.MQTT_SHARED_GROUP
            ? `$share/${config.MQTT_SHARED_GROUP}/`
            : '';
        const topic = `${sharedPrefix}${config.MQTT_STATUS_TOPIC}`;
        mqttClient.subscribe(topic, { qos: 1 }, (err) => {
            if (err) reject(err);
            else {
                logger.info({ topic }, 'Subscribed to device status topic');
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

        await processTelemetry(
            message,
            clients,
            config,
            logger,
            { topicOrigin: extractTopicOrigin(topic) }
        );
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

        if (!command_id || !device_id || !['success', 'error'].includes(status)) {
            logger.warn({ topic }, 'ACK message is missing required identity/status fields');
            return;
        }

        logger.debug({ command_id, device_id, status }, 'Received ACK message');
        const route = await validateCommandAck(
            clients.redis,
            ack,
            extractTopicOrigin(topic),
            config
        );

        // Update command status
        const commandStatus = status === 'success' ? 'acked' : 'failed';
        const errorMsg = status === 'success' ? null : error_msg || 'Device returned error';

        // Đẩy sự kiện qua Redis Stream thay vì chọc trực tiếp vào PostgreSQL
        await updateCommandStatus(clients.redis, config, command_id, commandStatus, errorMsg, logger);
        if (route.owner_id) {
            await recordActivity(
                clients,
                route.target_device_id,
                route.owner_id,
                `ack:${route.mode}`,
                config,
                logger
            );
            if (
                route.mode === 'relay'
                && route.hub_mac
                && route.hub_mac !== route.target_device_id
            ) {
                await recordActivity(
                    clients,
                    route.hub_mac,
                    route.owner_id,
                    'relay_ack',
                    config,
                    logger
                );
            }
        }

        logger.info({ command_id, device_id }, 'Command ACK processed');
    } catch (err) {
        logger.error({ err, topic }, 'Failed to process ACK message');
        // Không throw
    }
}

async function handleTopologyAckMessage(topic, payload, clients, config, logger) {
    try {
        const ack = JSON.parse(payload.toString());
        if (
            !ack
            || typeof ack.device_id !== 'string'
            || typeof ack.network_id !== 'string'
            || !Number.isSafeInteger(Number(ack.topology_epoch))
        ) {
            logger.warn({ topic }, 'Invalid topology ACK ignored');
            return;
        }
        const topology = await validateTopologyAck(
            clients.redis,
            ack,
            extractTopologyAckOrigin(topic),
            config
        );
        await clients.redis.publish(
            REDIS_CHANNELS.TOPOLOGY_HUB_ACK,
            JSON.stringify({
                device_id: topology.device_id,
                mac: topology.mac,
                network_id: topology.network_id,
                topology_epoch: topology.topology_epoch,
                status: ack.status,
                error_msg: ack.error_msg || null,
                timestamp: new Date().toISOString(),
            })
        );
        logger.info(
            {
                network_id: topology.network_id,
                hub_mac: topology.mac,
                topology_epoch: topology.topology_epoch,
                status: ack.status,
            },
            'Topology ACK accepted'
        );
    } catch (err) {
        logger.warn({ err, topic }, 'Topology ACK rejected');
    }
}

async function handleStatusMessage(topic, payload, clients, config, logger) {
    try {
        const status = JSON.parse(payload.toString());
        if (!status || typeof status.device_id !== 'string') {
            logger.warn({ topic }, 'Invalid device status message ignored');
            return;
        }
        const normalizedStatus = status.status
            || (status.is_online === false ? 'offline' : 'online');
        if (!['online', 'offline', 'heartbeat'].includes(normalizedStatus)) {
            logger.warn({ topic, status: normalizedStatus }, 'Unknown device status ignored');
            return;
        }
        const deviceId = status.device_id.trim().toUpperCase();
        const transport = await validateInboundTransport(
            clients.redis,
            {
                deviceId,
                topicOrigin: extractTopicOrigin(topic),
                transport: status.transport,
            },
            config
        );
        const context = await resolveDeviceContext(
            clients,
            deviceId,
            config,
            logger
        );
        if (
            !context.ownerId
            || (transport.owner_id && transport.owner_id !== context.ownerId)
        ) {
            logger.warn({ device_id: deviceId }, 'Status ownership validation failed');
            return;
        }
        if (normalizedStatus === 'offline') {
            await markTopologyTransportOffline(
                clients.redis,
                transport,
                config
            );
            await markDeviceOffline(
                clients,
                deviceId,
                context.ownerId,
                config,
                logger,
                `mqtt_status:${transport.mode}`
            );
            return;
        }
        await recordActivity(
            clients,
            deviceId,
            context.ownerId,
            `status:${transport.mode}`,
            config,
            logger
        );
        if (
            transport.mode === 'relay'
            && transport.hub_mac
            && transport.hub_mac !== deviceId
        ) {
            await recordActivity(
                clients,
                transport.hub_mac,
                context.ownerId,
                'relay_status',
                config,
                logger
            );
        }
    } catch (err) {
        logger.warn({ err, topic }, 'Device status message rejected');
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
    logger.info('setupMessageHandlers: Registering message handler');

    // Pre-compile regexes once instead of on every message
    const telemetryPattern = config.MQTT_TELEMETRY_TOPIC.replace(/\+/g, '[^/]+');
    const ackPattern = config.MQTT_ACK_TOPIC.replace(/\+/g, '[^/]+');
    const topologyAckPattern = config.MQTT_TOPOLOGY_ACK_TOPIC.replace(/\+/g, '[^/]+');
    const statusPattern = config.MQTT_STATUS_TOPIC.replace(/\+/g, '[^/]+');
    const telemetryRegex = new RegExp(`^${telemetryPattern}$`);
    const ackRegex = new RegExp(`^${ackPattern}$`);
    const topologyAckRegex = new RegExp(`^${topologyAckPattern}$`);
    const statusRegex = new RegExp(`^${statusPattern}$`);

    mqttClient.on('message', async (topic, payload) => {
        // Kiểm tra topic
        const cleanTopic = topic.startsWith('$share/')
            ? topic.split('/').slice(2).join('/')
            : topic;

        logger.debug({ cleanTopic, telemetryMatch: telemetryRegex.test(cleanTopic) }, 'setupMessageHandlers: Topic matching details');

        if (topologyAckRegex.test(cleanTopic)) {
            await handleTopologyAckMessage(cleanTopic, payload, clients, config, logger);
        } else if (telemetryRegex.test(cleanTopic)) {
            await handleTelemetryMessage(cleanTopic, payload, clients, config, logger);
        } else if (ackRegex.test(cleanTopic)) {
            await handleAckMessage(cleanTopic, payload, clients, config, logger);
        } else if (statusRegex.test(cleanTopic)) {
            await handleStatusMessage(cleanTopic, payload, clients, config, logger);
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
        await subscribeToTopologyAck(mqttClient, config, logger);
        await subscribeToStatus(mqttClient, config, logger);
        setupMessageHandlers(mqttClient, clients, config, logger);

        logger.info('Telemetry subscriber ready');
    } catch (err) {
        logger.error({ err }, 'Failed to start telemetry subscriber');
        throw err;
    }
}

module.exports = {
    startTelemetrySubscriber,
    handleTelemetryMessage,
    handleAckMessage,
    handleTopologyAckMessage,
    handleStatusMessage,
    extractTopicOrigin,
    extractTopologyAckOrigin,
};
