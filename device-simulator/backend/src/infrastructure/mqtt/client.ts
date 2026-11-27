import net from 'node:net';
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
    // 5–30 s, different for every device: after a broker restart thousands of
    // devices come back spread over half a minute instead of all at once.
    reconnectPeriod: 5000 + Math.floor(Math.random() * 25_000),
    connectTimeout: env.MQTT_CONNECT_TIMEOUT_MS,
});

export const resolveMqttTopic = (template: string, deviceId: string): string =>
    template
        .replaceAll('{device_id}', deviceId)
        .replaceAll('{hub_id}', deviceId);

/**
 * Whether the broker's MQTT port answers (a TCP connection, no login): the
 * Simulator has no broker account of its own, only its devices have one.
 */
export const probeMqtt = (timeoutMs = 5000): Promise<void> => new Promise((resolve, reject) => {
    const socket = net.connect({ host: env.MQTT_HOST, port: env.MQTT_PORT });
    const done = (error?: Error) => {
        socket.removeAllListeners();
        socket.destroy();
        if (error) reject(error);
        else resolve();
    };
    socket.setTimeout(timeoutMs, () => done(new Error(`MQTT broker ${env.MQTT_HOST}:${env.MQTT_PORT} did not answer`)));
    socket.once('connect', () => done());
    socket.once('error', (error) => done(error));
});
