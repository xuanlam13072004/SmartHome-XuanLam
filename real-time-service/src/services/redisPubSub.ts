import { getRedisSub } from '../loaders/redis.js';
import { applyAccessChange, closeSessions, recipientsOf, sendToUser } from './connectionManager.js';
import { REDIS_CHANNELS } from '../../../shared/constants.js';

const CHANNELS = [
    REDIS_CHANNELS.DEVICE_TELEMETRY,
    REDIS_CHANNELS.DEVICE_EVENT,
    REDIS_CHANNELS.DEVICE_STATUS,
    REDIS_CHANNELS.DEVICE_OPERATION,
    REDIS_CHANNELS.DEVICE_CREDENTIAL,
    REDIS_CHANNELS.TOPOLOGY_UPDATED,
    REDIS_CHANNELS.DEVICE_ACCESS_CHANGED,
    REDIS_CHANNELS.ACCOUNT_SESSIONS_REVOKED,
    REDIS_CHANNELS.ACCOUNT_EVENT,
];

/** Personal events the Gateway may send to one account (sharing invitations, scene progress, automations…). */
export const ACCOUNT_EVENT_NAME = /^(sharing|notification|scene|automation)_[a-z_]{1,40}$/;

/** Device state, events and presence go to everyone who may see the device. */
const AUDIENCE_CHANNELS = new Set<string>([
    REDIS_CHANNELS.DEVICE_TELEMETRY,
    REDIS_CHANNELS.DEVICE_EVENT,
    REDIS_CHANNELS.DEVICE_STATUS,
]);

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

            if (channel === REDIS_CHANNELS.DEVICE_ACCESS_CHANGED) {
                if (typeof parsed.mac !== 'string') return;
                applyAccessChange(
                    parsed.mac,
                    Array.isArray(parsed.access_account_ids) ? parsed.access_account_ids.map(String) : [],
                    Array.isArray(parsed.removed_account_ids) ? parsed.removed_account_ids.map(String) : [],
                );
                return;
            }

            if (channel === REDIS_CHANNELS.ACCOUNT_SESSIONS_REVOKED) {
                if (typeof parsed.account_id !== 'string') return;
                closeSessions(
                    parsed.account_id,
                    parsed.all === true
                        ? 'all'
                        : (Array.isArray(parsed.session_ids) ? parsed.session_ids.map(String) : []),
                );
                return;
            }

            if (channel === REDIS_CHANNELS.ACCOUNT_EVENT) {
                if (typeof parsed.account_id !== 'string' || !ACCOUNT_EVENT_NAME.test(String(parsed.event))) return;
                sendToUser(parsed.account_id, {
                    event: parsed.event,
                    data: parsed.data && typeof parsed.data === 'object' ? parsed.data : {},
                    timestamp: new Date().toISOString(),
                });
                return;
            }

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
            } else if (channel === REDIS_CHANNELS.DEVICE_EVENT) {
                eventName = 'device_event';
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
                : AUDIENCE_CHANNELS.has(channel)
                    ? recipientsOf(mac, owner_id)
                    : [owner_id];
            for (const accountId of new Set(recipients)) sendToUser(accountId, outgoingMessage);
        } catch (err) {
            console.error(`❌ Failed to parse/route message from channel ${channel}:`, err, message);
        }
    });
}
