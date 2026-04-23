const mqtt = require('mqtt');

/**
 * Tác dụng của file này:
 * - Tách toàn bộ logic kết nối MQTT ra khỏi src/index.js
 * - Giúp index.js chỉ còn nhiệm vụ orchestration
 * - Sau này muốn thêm subscribe topic, publish helper, hoặc custom retry thì sửa ở đây
 *
 * Ý tưởng thiết kế:
 * - Hàm createMqttClient nhận config + logger
 * - Tạo MQTT client
 * - Gắn event cơ bản để theo dõi kết nối
 * - Trả về client để file khác dùng
 */
function createMqttClient({ brokerUrl, clientId, username, password, logger }) {
    const mqttOptions = {
        clientId,
        clean: true,
        connectTimeout: 5000,
        reconnectPeriod: 2000,
    };

    if (username) mqttOptions.username = username;
    if (password) mqttOptions.password = password;

    const client = mqtt.connect(brokerUrl, mqttOptions);

    client.on('connect', () => {
        logger.info('MQTT connected');
    });

    client.on('error', (err) => {
        logger.error({ err }, 'MQTT client error');
    });

    client.on('reconnect', () => {
        logger.warn('MQTT reconnecting');
    });

    client.on('close', () => {
        logger.warn('MQTT connection closed');
    });

    return client;
}

module.exports = {
    createMqttClient,
};
