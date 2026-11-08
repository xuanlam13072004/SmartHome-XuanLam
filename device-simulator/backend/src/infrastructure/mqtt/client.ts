import mqtt from 'mqtt';
import { env } from '../../config/env';

export interface BrokerCredentials {
    username: string;
    password: string;
}

const brokerUrl = (): string => `mqtt://${env.MQTT_HOST}:${env.MQTT_PORT}`;

/**
 * Creates the MQTT connection of one virtual device. Like a physical device it
 * authenticates with username = MAC and its own factory-issued password.
 */
export const createDeviceMqttClient = (
    clientId: string,
    credentials: BrokerCredentials,
    cleanSession: boolean = true,
): mqtt.MqttClient => mqtt.connect(brokerUrl(), {
    clientId,
    username: credentials.username,
    password: credentials.password,
    clean: cleanSession,
    // Jittered so thousands of devices do not reconnect in lockstep after a broker restart.
    reconnectPeriod: 3000 + Math.floor(Math.random() * 7000),
    connectTimeout: env.MQTT_CONNECT_TIMEOUT_MS,
});

/** Connection of the virtual-device factory (Dynamic Security client management only). */
export const createFactoryMqttClient = (clientId: string): mqtt.MqttClient => mqtt.connect(brokerUrl(), {
    clientId,
    username: env.MQTT_FACTORY_USERNAME,
    password: env.MQTT_FACTORY_PASSWORD || undefined,
    clean: true,
    reconnectPeriod: 5000,
    connectTimeout: env.MQTT_CONNECT_TIMEOUT_MS,
});

export const resolveMqttTopic = (template: string, deviceId: string): string =>
    template
        .replaceAll('{device_id}', deviceId)
        .replaceAll('{hub_id}', deviceId);

export const probeMqtt = async (): Promise<void> => {
    const probeClient = mqtt.connect(brokerUrl(), {
        clientId: `device-simulator-preflight-${process.pid}-${Date.now()}`,
        username: env.MQTT_FACTORY_USERNAME,
        password: env.MQTT_FACTORY_PASSWORD || undefined,
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
