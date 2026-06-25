import { getRedisSub } from '../loaders/redis.js';
import { sendToUser } from './connectionManager.js';
import { REDIS_CHANNELS } from '../../../shared/constants.js';

const CHANNELS = [
    REDIS_CHANNELS.DEVICE_TELEMETRY,
    REDIS_CHANNELS.DEVICE_STATUS,
    REDIS_CHANNELS.DEVICE_COMMAND
];

export function startRedisPubSubListener(): void {
    const redisSub = getRedisSub();

    redisSub.subscribe(...CHANNELS, (err, count) => {
        if (err) {
            console.error('❌ Failed to subscribe to Redis Pub/Sub channels:', err);
            return;
        }
        console.log(`📡 Subscribed to ${count} Redis Pub/Sub channels: [${CHANNELS.join(', ')}]`);
    });

    redisSub.on('message', (channel, message) => {
        try {
            const parsed = JSON.parse(message);
            const { owner_id, mac, payload, timestamp } = parsed;

            if (!owner_id) {
                console.warn(`⚠️ Received message on channel ${channel} without owner_id:`, message);
                return;
            }

            // Map the Redis channel name to the event name used by the WS client
            // channel 'device.telemetry' -> event 'telemetry'
            // channel 'device.status' -> event 'device_status'
            // channel 'device.command' -> event 'command_status'
            let eventName = 'notification';
            if (channel === REDIS_CHANNELS.DEVICE_TELEMETRY) {
                eventName = 'telemetry';
            } else if (channel === REDIS_CHANNELS.DEVICE_STATUS) {
                eventName = 'device_status';
            } else if (channel === REDIS_CHANNELS.DEVICE_COMMAND) {
                eventName = 'command_status';
            }

            const outgoingMessage = {
                event: eventName,
                mac: mac || null,
                payload: payload || {},
                timestamp: timestamp || new Date().toISOString(),
            };

            // Route to active connections in memory
            sendToUser(owner_id, outgoingMessage);
        } catch (err) {
            console.error(`❌ Failed to parse/route message from channel ${channel}:`, err, message);
        }
    });
}
