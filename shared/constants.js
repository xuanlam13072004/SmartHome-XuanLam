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
};

module.exports = {
    REDIS_CHANNELS,
    COMMAND_STATUS,
    CACHE_PREFIXES,
};
