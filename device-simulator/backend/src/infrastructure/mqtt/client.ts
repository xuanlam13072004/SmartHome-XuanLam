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
        reconnectPeriod: 5000,
        connectTimeout: env.MQTT_CONNECT_TIMEOUT_MS,
    });
};

export const resolveMqttTopic = (template: string, deviceId: string): string =>
    template.replaceAll('{device_id}', deviceId);

export const probeMqtt = async (): Promise<void> => {
    const brokerUrl = `mqtt://${env.MQTT_HOST}:${env.MQTT_PORT}`;
    const probeClient = mqtt.connect(brokerUrl, {
        clientId: `device-simulator-preflight-${process.pid}-${Date.now()}`,
        username: env.MQTT_USERNAME || undefined,
        password: env.MQTT_PASSWORD || undefined,
        clean: true,
        reconnectPeriod: 0,
        connectTimeout: env.MQTT_CONNECT_TIMEOUT_MS,
    });

    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            probeClient.end(true);
            reject(new Error('MQTT preflight timed out'));
        }, env.MQTT_CONNECT_TIMEOUT_MS + 250);

        probeClient.once('connect', () => {
            clearTimeout(timer);
            probeClient.end(true, {}, (error) => error ? reject(error) : resolve());
        });
        probeClient.once('error', (error) => {
            clearTimeout(timer);
            probeClient.end(true);
            reject(error);
        });
    });
};
