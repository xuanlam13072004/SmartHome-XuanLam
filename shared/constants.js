/**
 * shared/constants.js
 * 
 * Các hằng số hệ thống dùng chung (Shared Constants) giữa các dịch vụ:
 * - API Gateway (TypeScript)
 * - MQTT Worker Service (JavaScript)
 * - Realtime Service (TypeScript)
 */

const REDIS_CHANNELS = {
    DEVICE_TELEMETRY: 'device.telemetry',
    DEVICE_STATUS: 'device.status',
    DEVICE_COMMAND: 'device.command',
    CATALOG_UPDATED: 'catalog:updated',
    DEVICE_CONTEXT_INVALIDATED: 'device.context.invalidated',
    TOPOLOGY_UPDATED: 'topology.updated',
    TOPOLOGY_REMOVED: 'topology.removed',
    TOPOLOGY_HUB_ACK: 'topology.hub.ack',
};

const COMMAND_STATUS = {
    PENDING: 'pending',
    SENDING: 'sending',
    SENT: 'sent',
    ACKED: 'acked',
    FAILED: 'failed',
    TIMEOUT: 'timeout',
};

const CACHE_PREFIXES = {
    OWNER_OF: 'owner_of:',
    PRODUCT_OF: 'product_of:',
    ONLINE_LEASE: 'device:online:',
    TOPOLOGY_NETWORK: 'topology:network:',
    TOPOLOGY_DEVICE: 'topology:device:',
    TOPOLOGY_ROUTE: 'topology:route:',
    TOPOLOGY_REMOVED: 'topology:removed:',
    HUB_LEASE: 'topology:hub:lease:',
    COMMAND_ROUTE: 'command_route:',
    ELECTION_LOCK: 'topology:election:lock:',
    ELECTION_FAILED: 'topology:election:failed:',
};

module.exports = {
    REDIS_CHANNELS,
    COMMAND_STATUS,
    CACHE_PREFIXES,
};
