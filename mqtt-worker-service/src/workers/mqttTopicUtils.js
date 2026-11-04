'use strict';

function extractTopicOrigin(topic) {
    const parts = topic.split('/').filter(Boolean);
    return parts.length >= 2 ? parts[parts.length - 2].toUpperCase() : '';
}

function sharedTopic(config, topic) {
    return config.MQTT_SHARED_GROUP
        ? `$share/${config.MQTT_SHARED_GROUP}/${topic}`
        : topic;
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

function topicRegex(template) {
    const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escaped.replace(/\\\+/g, '[^/]+')}$`);
}

module.exports = {
    extractTopicOrigin,
    sharedTopic,
    subscribe,
    topicRegex,
};
