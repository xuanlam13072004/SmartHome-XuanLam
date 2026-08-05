'use strict';

const REDIS_CHANNELS = {
    DEVICE_TELEMETRY: 'device.telemetry',
    DEVICE_STATUS: 'device.status',
    DEVICE_OPERATION: 'device.operation',
    DEVICE_CREDENTIAL: 'device.credential',
    DEVICE_CONTEXT_INVALIDATED: 'device.context.invalidated',
    TOPOLOGY_UPDATED: 'topology.updated',
    TOPOLOGY_REMOVED: 'topology.removed',
    TOPOLOGY_HUB_ACK: 'topology.hub.ack',
};

const OPERATION_STATUS = {
    ACCEPTED: 'accepted',
    QUEUED: 'queued',
    DISPATCHED: 'dispatched',
    EXECUTING: 'executing',
    SUCCEEDED: 'succeeded',
    REJECTED: 'rejected',
    FAILED: 'failed',
    TIMED_OUT: 'timed_out',
    CANCELLED: 'cancelled',
};

const TERMINAL_OPERATION_STATUSES = new Set([
    OPERATION_STATUS.SUCCEEDED,
    OPERATION_STATUS.REJECTED,
    OPERATION_STATUS.FAILED,
    OPERATION_STATUS.TIMED_OUT,
    OPERATION_STATUS.CANCELLED,
]);

const CACHE_PREFIXES = {
    OWNER_OF: 'owner_of:',
    PRODUCT_OF: 'product_of:',
    CATALOG_REVISION_OF: 'catalog_revision_of:',
    ONLINE_LEASE: 'device:online:',
    TOPOLOGY_NETWORK: 'topology:network:',
    TOPOLOGY_DEVICE: 'topology:device:',
    TOPOLOGY_ROUTE: 'topology:route:',
    TOPOLOGY_REMOVED: 'topology:removed:',
    HUB_LEASE: 'topology:hub:lease:',
    OPERATION_ROUTE: 'operation:route:',
    ELECTION_LOCK: 'topology:election:lock:',
    ELECTION_FAILED: 'topology:election:failed:',
};

module.exports = {
    CACHE_PREFIXES,
    OPERATION_STATUS,
    REDIS_CHANNELS,
    TERMINAL_OPERATION_STATUSES,
};
