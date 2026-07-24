import mqtt from 'mqtt';
import { env } from '../../config/env';

/**
 * Creates a new MQTT client for a specific virtual device.
 * @param clientId The MAC address of the virtual device.
 * @param cleanSession Whether to start a clean session (usually true for virtual devices).
 */
export const createDeviceMqttClient = (clientId: string, cleanSession: boolean = true): mqtt.MqttClient => {
    const brokerUrl = `mqtt://${env.MQTT_HOST}:${env.MQTT_PORT}`;
    
    return mqtt.connect(brokerUrl, {
        clientId,
        username: env.MQTT_USERNAME || undefined,
        password: env.MQTT_PASSWORD || undefined,
        clean: cleanSession,
        reconnectPeriod: 5000, // exponential backoff might be needed later
        connectTimeout: 10 * 1000,
    });
};
