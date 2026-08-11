'use strict';

const { processTelemetry, resolveDeviceContext } = require('../services/telemetryProcessor');
const { updateOperationStatus } = require('../services/operationProcessor');
const { updateCredentialStatus } = require('../services/credentialProcessor');
const {
    validateOperationAck,
    validateTopologyAck,
    validateInboundTransport,
    markTopologyTransportOffline,
} = require('../services/topologyRuntime');
const { recordActivity, markDeviceOffline } = require('../services/presenceManager');
const { REDIS_CHANNELS } = require('../../../shared/constants');

function extractTopicOrigin(topic) {
    const parts = topic.split('/').filter(Boolean);
    return parts.length >= 2 ? parts[parts.length - 2].toUpperCase() : '';
}

function extractTopologyAckOrigin(topic) {
    const parts = topic.split('/').filter(Boolean);
    return parts.length >= 3 ? parts[parts.length - 3].toUpperCase() : '';
}

function sharedTopic(config, topic) {
    return config.MQTT_SHARED_GROUP
        ? `$share/${config.MQTT_SHARED_GROUP}/${topic}`
        : topic;
}

function assertPresenceProductIdentity(status, context) {
    // Identity fields were added compatibly to presence.v2. Older physical
    // firmware may omit them; senders that provide them must match ownership.
    if (status.product_id === undefined && status.catalog_revision === undefined) return;
    if (
        typeof status.product_id !== 'string'
        || !Number.isSafeInteger(Number(status.catalog_revision))
        || status.product_id !== context.productId
        || Number(status.catalog_revision) !== context.catalogRevision
    ) {
        throw new Error('Presence Product identity does not match the claimed device');
    }
}

function subscribe(mqttClient, topic, qos, logger) {
    return new Promise((resolve, reject) => {
        mqttClient.subscribe(topic, { qos }, error => {
            if (error) reject(error);
            else {
                logger.info({ topic }, 'MQTT subscription ready');
                resolve();
            }
        });
    });
}

async function handleTelemetryMessage(topic, payload, clients, config, logger) {
    try {
        await processTelemetry(
            JSON.parse(payload.toString()),
            clients,
            config,
            logger,
            { topicOrigin: extractTopicOrigin(topic) },
        );
    } catch (error) {
        logger.warn({ err: error, topic }, 'Telemetry message rejected');
    }
}

async function handleOperationAckMessage(topic, payload, clients, config, logger) {
    try {
        const ack = JSON.parse(payload.toString());
        if (ack?.schema === 'device.credential.ack.v2') {
            if (
                typeof ack.job_id !== 'string'
                || typeof ack.device_id !== 'string'
                || !['succeeded', 'rejected', 'failed'].includes(ack.status)
            ) {
                throw new Error('Invalid credential ACK contract');
            }
            const route = await validateOperationAck(
                clients.redis,
                { ...ack, operation_id: ack.job_id },
                extractTopicOrigin(topic),
                config,
            );
            await updateCredentialStatus(
                clients.redis,
                config,
                ack.job_id,
                ack.status,
                ack.reason_code || null,
            );
            await recordActivity(
                clients,
                route.target_device_id,
                route.owner_id,
                `credential_ack:${route.mode}`,
                config,
                logger,
            );
            return;
        }
        if (
            ack?.schema !== 'device.operation.ack.v2'
            || typeof ack.operation_id !== 'string'
            || typeof ack.device_id !== 'string'
            || !['succeeded', 'rejected', 'failed'].includes(ack.status)
        ) {
            throw new Error('Invalid operation ACK contract');
        }
        const route = await validateOperationAck(
            clients.redis,
            ack,
            extractTopicOrigin(topic),
            config,
        );
        await updateOperationStatus(
            clients.redis,
            config,
            ack.operation_id,
            ack.status,
            ack.reason_code || null,
            ack.details || {},
        );
        await recordActivity(
            clients,
            route.target_device_id,
            route.owner_id,
            `operation_ack:${route.mode}`,
            config,
            logger,
        );
        if (route.mode === 'relay' && route.hub_mac !== route.target_device_id) {
            await recordActivity(
                clients,
                route.hub_mac,
                route.owner_id,
                'relay_operation_ack',
                config,
                logger,
            );
        }
    } catch (error) {
        logger.warn({ err: error, topic }, 'Operation ACK rejected');
    }
}

async function handleTopologyAckMessage(topic, payload, clients, config, logger) {
    try {
        const ack = JSON.parse(payload.toString());
        if (
            ack?.schema !== 'device.topology.ack.v2'
            || typeof ack.device_id !== 'string'
            || typeof ack.network_id !== 'string'
            || !Number.isSafeInteger(Number(ack.topology_epoch))
        ) {
            throw new Error('Invalid topology ACK contract');
        }
        const topology = await validateTopologyAck(
            clients.redis,
            ack,
            extractTopologyAckOrigin(topic),
            config,
        );
        await clients.redis.publish(REDIS_CHANNELS.TOPOLOGY_HUB_ACK, JSON.stringify({
            device_id: topology.device_id,
            mac: topology.mac,
            network_id: topology.network_id,
            topology_epoch: topology.topology_epoch,
            status: ack.status,
            reason_code: ack.reason_code || null,
            timestamp: new Date().toISOString(),
        }));
    } catch (error) {
        logger.warn({ err: error, topic }, 'Topology ACK rejected');
    }
}

async function handleStatusMessage(topic, payload, clients, config, logger) {
    try {
        const status = JSON.parse(payload.toString());
        if (status?.schema !== 'device.presence.v2' || typeof status.device_id !== 'string') {
            throw new Error('Invalid presence contract');
        }
        if (!['online', 'offline', 'heartbeat'].includes(status.status)) {
            throw new Error('Unsupported presence status');
        }
        const deviceId = status.device_id.trim().toUpperCase();
        const transport = await validateInboundTransport(
            clients.redis,
            {
                deviceId,
                topicOrigin: extractTopicOrigin(topic),
                transport: status.transport,
            },
            config,
        );
        const context = await resolveDeviceContext(clients, deviceId, config, logger);
        assertPresenceProductIdentity(status, context);
        if (!context.ownerId || transport.owner_id !== context.ownerId) {
            throw new Error('Presence ownership does not match topology');
        }
        if (status.status === 'offline') {
            await markTopologyTransportOffline(clients.redis, transport, config);
            await markDeviceOffline(
                clients,
                deviceId,
                context.ownerId,
                config,
                logger,
                `mqtt_status:${transport.mode}`,
            );
            return;
        }
        await recordActivity(
            clients,
            deviceId,
            context.ownerId,
            `status:${transport.mode}`,
            config,
            logger,
        );
        if (transport.mode === 'relay' && transport.hub_mac !== deviceId) {
            await recordActivity(
                clients,
                transport.hub_mac,
                context.ownerId,
                'relay_status',
                config,
                logger,
            );
        }
    } catch (error) {
        logger.warn({ err: error, topic }, 'Presence message rejected');
    }
}

function topicRegex(template) {
    return new RegExp(`^${template.replace(/\+/g, '[^/]+')}$`);
}

function setupMessageHandlers(mqttClient, clients, config, logger) {
    const telemetry = topicRegex(config.MQTT_TELEMETRY_TOPIC);
    const operationAck = topicRegex(config.MQTT_ACK_TOPIC);
    const topologyAck = topicRegex(config.MQTT_TOPOLOGY_ACK_TOPIC);
    const status = topicRegex(config.MQTT_STATUS_TOPIC);
    mqttClient.on('message', async (topic, payload) => {
        const cleanTopic = topic.startsWith('$share/')
            ? topic.split('/').slice(2).join('/')
            : topic;
        if (topologyAck.test(cleanTopic)) {
            await handleTopologyAckMessage(cleanTopic, payload, clients, config, logger);
        } else if (telemetry.test(cleanTopic)) {
            await handleTelemetryMessage(cleanTopic, payload, clients, config, logger);
        } else if (operationAck.test(cleanTopic)) {
            await handleOperationAckMessage(cleanTopic, payload, clients, config, logger);
        } else if (status.test(cleanTopic)) {
            await handleStatusMessage(cleanTopic, payload, clients, config, logger);
        }
    });
}

async function startTelemetrySubscriber(mqttClient, clients, config, logger) {
    await Promise.all([
        subscribe(mqttClient, sharedTopic(config, config.MQTT_TELEMETRY_TOPIC), config.MQTT_QOS, logger),
        subscribe(mqttClient, sharedTopic(config, config.MQTT_ACK_TOPIC), config.MQTT_QOS, logger),
        subscribe(mqttClient, sharedTopic(config, config.MQTT_TOPOLOGY_ACK_TOPIC), config.MQTT_QOS, logger),
        subscribe(mqttClient, sharedTopic(config, config.MQTT_STATUS_TOPIC), config.MQTT_QOS, logger),
    ]);
    setupMessageHandlers(mqttClient, clients, config, logger);
}

module.exports = {
    assertPresenceProductIdentity,
    extractTopicOrigin,
    extractTopologyAckOrigin,
    handleOperationAckMessage,
    handleStatusMessage,
    handleTelemetryMessage,
    handleTopologyAckMessage,
    startTelemetrySubscriber,
};
