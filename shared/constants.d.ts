export declare const REDIS_CHANNELS: {
    readonly DEVICE_TELEMETRY: "device.telemetry";
    readonly DEVICE_STATUS: "device.status";
    readonly DEVICE_COMMAND: "device.command";
    readonly CATALOG_UPDATED: "catalog:updated";
    readonly DEVICE_CONTEXT_INVALIDATED: "device.context.invalidated";
    readonly TOPOLOGY_UPDATED: "topology.updated";
    readonly TOPOLOGY_REMOVED: "topology.removed";
    readonly TOPOLOGY_HUB_ACK: "topology.hub.ack";
};

export declare const COMMAND_STATUS: {
    readonly PENDING: "pending";
    readonly SENDING: "sending";
    readonly SENT: "sent";
    readonly ACKED: "acked";
    readonly FAILED: "failed";
    readonly TIMEOUT: "timeout";
};

export declare const CACHE_PREFIXES: {
    readonly OWNER_OF: "owner_of:";
    readonly PRODUCT_OF: "product_of:";
    readonly ONLINE_LEASE: "device:online:";
    readonly TOPOLOGY_NETWORK: "topology:network:";
    readonly TOPOLOGY_DEVICE: "topology:device:";
    readonly TOPOLOGY_ROUTE: "topology:route:";
    readonly TOPOLOGY_REMOVED: "topology:removed:";
    readonly HUB_LEASE: "topology:hub:lease:";
    readonly COMMAND_ROUTE: "command_route:";
    readonly ELECTION_LOCK: "topology:election:lock:";
    readonly ELECTION_FAILED: "topology:election:failed:";
};
