export declare const REDIS_CHANNELS: {
    readonly DEVICE_TELEMETRY: 'device.telemetry';
    readonly DEVICE_STATUS: 'device.status';
    readonly DEVICE_OPERATION: 'device.operation';
    readonly DEVICE_CREDENTIAL: 'device.credential';
    readonly DEVICE_CONTEXT_INVALIDATED: 'device.context.invalidated';
    readonly TOPOLOGY_UPDATED: 'topology.updated';
    readonly TOPOLOGY_REMOVED: 'topology.removed';
    readonly TOPOLOGY_HUB_ACK: 'topology.hub.ack';
};

export declare const OPERATION_STATUS: {
    readonly ACCEPTED: 'accepted';
    readonly QUEUED: 'queued';
    readonly DISPATCHED: 'dispatched';
    readonly EXECUTING: 'executing';
    readonly SUCCEEDED: 'succeeded';
    readonly REJECTED: 'rejected';
    readonly FAILED: 'failed';
    readonly TIMED_OUT: 'timed_out';
    readonly CANCELLED: 'cancelled';
};

export declare const TERMINAL_OPERATION_STATUSES: Set<string>;

export declare const CACHE_PREFIXES: {
    readonly OWNER_OF: 'owner_of:';
    readonly PRODUCT_OF: 'product_of:';
    readonly CATALOG_REVISION_OF: 'catalog_revision_of:';
    readonly ONLINE_LEASE: 'device:online:';
    readonly TOPOLOGY_NETWORK: 'topology:network:';
    readonly TOPOLOGY_DEVICE: 'topology:device:';
    readonly TOPOLOGY_ROUTE: 'topology:route:';
    readonly TOPOLOGY_REMOVED: 'topology:removed:';
    readonly HUB_LEASE: 'topology:hub:lease:';
    readonly OPERATION_ROUTE: 'operation:route:';
    readonly ELECTION_LOCK: 'topology:election:lock:';
    readonly ELECTION_FAILED: 'topology:election:failed:';
};
