import { getRedisSub } from '../loaders/redis.js';
import { sendToUser } from './connectionManager.js';
import { REDIS_CHANNELS } from '../../../shared/constants.js';

const CHANNELS = [
    REDIS_CHANNELS.DEVICE_TELEMETRY,
    REDIS_CHANNELS.DEVICE_STATUS,
    REDIS_CHANNELS.DEVICE_OPERATION,
    REDIS_CHANNELS.DEVICE_CREDENTIAL,
    REDIS_CHANNELS.TOPOLOGY_UPDATED,
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

            if (channel === REDIS_CHANNELS.TOPOLOGY_UPDATED) {
                if (!parsed.owner_id) {
                    console.warn('⚠️ Received topology update without owner_id:', message);
                    return;
                }
                sendToUser(parsed.owner_id, {
                    event: 'topology_updated',
                    network_id: parsed.network_id,
                    topology_epoch: parsed.topology_epoch,
                    topology_state: parsed.topology_state,
                    active_hub_mac: parsed.active_hub_mac || null,
                    members: Array.isArray(parsed.members) ? parsed.members : [],
                    change: parsed.change || null,
                    timestamp: parsed.topology_updated_at || new Date().toISOString(),
                });
                return;
            }

            const { owner_id, recipient_ids, mac, payload, timestamp } = parsed;

            if (!owner_id) {
                console.warn(`⚠️ Received message on channel ${channel} without owner_id:`, message);
                return;
            }

            // Map the Redis channel name to the event name used by the WS client
            // channel 'device.telemetry' -> event 'telemetry'
            // channel 'device.status' -> event 'device_status'
            let eventName = 'notification';
            if (channel === REDIS_CHANNELS.DEVICE_TELEMETRY) {
                eventName = 'telemetry';
            } else if (channel === REDIS_CHANNELS.DEVICE_STATUS) {
                eventName = 'device_status';
            } else if (channel === REDIS_CHANNELS.DEVICE_OPERATION) {
                eventName = 'operation_status';
            } else if (channel === REDIS_CHANNELS.DEVICE_CREDENTIAL) {
                eventName = 'credential_status';
            }

            const outgoingMessage = {
                event: eventName,
                mac: mac || null,
                payload: payload || {},
                timestamp: timestamp || new Date().toISOString(),
            };

            // Route to active connections in memory
            const recipients = Array.isArray(recipient_ids) && recipient_ids.length > 0
                ? recipient_ids
                : [owner_id];
            for (const accountId of new Set(recipients)) sendToUser(accountId, outgoingMessage);
        } catch (err) {
            console.error(`❌ Failed to parse/route message from channel ${channel}:`, err, message);
        }
    });
}
