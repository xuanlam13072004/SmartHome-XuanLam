'use strict';

const { processDeviceEvent } = require('../services/deviceEventProcessor');
const {
    extractTopicOrigin,
    sharedTopic,
    subscribe,
    topicRegex,
} = require('./mqttTopicUtils');

async function handleDeviceEventMessage(topic, payload, clients, config, logger) {
    try {
        if (payload.length > config.MQTT_EVENT_MAX_PAYLOAD_BYTES) {
            throw new Error(`Device event exceeds ${config.MQTT_EVENT_MAX_PAYLOAD_BYTES} bytes`);
        }
        await processDeviceEvent(
            JSON.parse(payload.toString()),
            clients,
            config,
            logger,
            { topicOrigin: extractTopicOrigin(topic) },
        );
    } catch (error) {
        logger.warn({ err: error, topic }, 'Device event rejected');
    }
}

async function startDeviceEventSubscriber(mqttClient, clients, config, logger) {
    await subscribe(
        mqttClient,
        sharedTopic(config, config.MQTT_EVENT_TOPIC),
        config.MQTT_QOS,
        logger,
    );
    const eventTopic = topicRegex(config.MQTT_EVENT_TOPIC);
    const listener = async (topic, payload) => {
        const cleanTopic = topic.startsWith('$share/')
            ? topic.split('/').slice(2).join('/')
            : topic;
        if (eventTopic.test(cleanTopic)) {
            await handleDeviceEventMessage(cleanTopic, payload, clients, config, logger);
        }
    };
    mqttClient.on('message', listener);
    return () => mqttClient.off('message', listener);
}

module.exports = {
    handleDeviceEventMessage,
    startDeviceEventSubscriber,
};
