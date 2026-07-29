const { CACHE_PREFIXES } = require('../../../shared/constants');

class TopologyRoutingError extends Error {
    constructor(message, code, retryable = false) {
        super(message);
        this.name = 'TopologyRoutingError';
        this.code = code;
        this.retryable = retryable;
    }
}

function normalizeMac(mac) {
    return typeof mac === 'string' ? mac.trim().toUpperCase() : '';
}

function topologyDeviceKey(mac) {
    return `${CACHE_PREFIXES.TOPOLOGY_DEVICE}${normalizeMac(mac)}`;
}

function topologyRouteKey(networkId) {
    return `${CACHE_PREFIXES.TOPOLOGY_ROUTE}${networkId}`;
}

function hubLeaseKey(networkId) {
    return `${CACHE_PREFIXES.HUB_LEASE}${networkId}`;
}

function commandRouteKey(commandId) {
    return `${CACHE_PREFIXES.COMMAND_ROUTE}${commandId}`;
}

function parseJson(value, label) {
    if (!value) return null;
    try {
        return JSON.parse(value);
    } catch {
        throw new TopologyRoutingError(
            `${label} contains invalid JSON`,
            'TOPOLOGY_CACHE_INVALID',
            true
        );
    }
}

function safeEpoch(value, label = 'topology_epoch') {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new TopologyRoutingError(
            `${label} is invalid`,
            'TOPOLOGY_EPOCH_INVALID'
        );
    }
    return parsed;
}

async function resolveDeviceTopology(redis, mac) {
    const raw = await redis.get(topologyDeviceKey(mac));
    const topology = parseJson(raw, 'Device topology cache');
    if (!topology) return null;

    if (
        normalizeMac(topology.mac) !== normalizeMac(mac)
        || !topology.network_id
        || !topology.owner_id
    ) {
        throw new TopologyRoutingError(
            'Device topology cache is inconsistent',
            'TOPOLOGY_CACHE_INVALID',
            true
        );
    }
    return {
        ...topology,
        mac: normalizeMac(topology.mac),
        active_hub_mac: topology.active_hub_mac
            ? normalizeMac(topology.active_hub_mac)
            : null,
        topology_epoch: safeEpoch(topology.topology_epoch),
        member_count: Number(topology.member_count || 0),
    };
}

async function renewHubLease(redis, topology, config) {
    if (!topology?.network_id || !topology.active_hub_mac) return;
    await redis.set(
        hubLeaseKey(topology.network_id),
        JSON.stringify({
            network_id: topology.network_id,
            hub_mac: topology.active_hub_mac,
            topology_epoch: topology.topology_epoch,
        }),
        'EX',
        config.HUB_LEASE_SECONDS
    );
    if (topology.topology_state === 'stable') {
        await redis.del(topologyRouteKey(topology.network_id));
    }
}

async function activateDirectFallback(redis, topology, config) {
    await redis.set(
        topologyRouteKey(topology.network_id),
        JSON.stringify({
            mode: 'direct_fallback',
            topology_epoch: topology.topology_epoch,
            detected_at: new Date().toISOString(),
        }),
        'EX',
        config.DIRECT_FALLBACK_ROUTE_SECONDS
    );
}

async function hasCurrentHubLease(redis, topology) {
    if (!topology.active_hub_mac) return false;
    const lease = parseJson(
        await redis.get(hubLeaseKey(topology.network_id)),
        'Hub lease'
    );
    return Boolean(
        lease
        && normalizeMac(lease.hub_mac) === topology.active_hub_mac
        && safeEpoch(lease.topology_epoch, 'hub_lease_epoch')
            === topology.topology_epoch
    );
}

async function resolveCommandRoute(redis, command, config) {
    const targetMac = normalizeMac(command.device_id);
    const topology = await resolveDeviceTopology(redis, targetMac);
    if (!topology) {
        return {
            mode: 'direct',
            owner_id: command.owner_id,
            target_device_id: targetMac,
            publish_device_id: targetMac,
            expected_ack_origin: targetMac,
            network_id: null,
            topology_epoch: null,
            hub_mac: null,
            compatibility_legacy: true,
        };
    }
    if (topology.owner_id !== command.owner_id) {
        throw new TopologyRoutingError(
            'Command owner does not match topology owner',
            'TOPOLOGY_OWNER_MISMATCH'
        );
    }
    if (topology.topology_state === 'empty') {
        throw new TopologyRoutingError(
            'Target device is not a member of an active network',
            'TOPOLOGY_DEVICE_REMOVED'
        );
    }

    const baseRoute = {
        owner_id: command.owner_id,
        target_device_id: targetMac,
        network_id: topology.network_id,
        topology_epoch: topology.topology_epoch,
        member_count: topology.member_count,
        compatibility_legacy: topology.member_count === 1,
    };

    if (topology.role === 'hub') {
        return {
            ...baseRoute,
            mode: 'hub',
            hub_mac: targetMac,
            publish_device_id: targetMac,
            expected_ack_origin: targetMac,
        };
    }

    const routeOverride = parseJson(
        await redis.get(topologyRouteKey(topology.network_id)),
        'Topology route override'
    );
    const overrideIsCurrent = Boolean(
        routeOverride
        && routeOverride.mode === 'direct_fallback'
        && safeEpoch(routeOverride.topology_epoch, 'route_override_epoch')
            === topology.topology_epoch
    );
    const hubLeaseIsCurrent = await hasCurrentHubLease(redis, topology);
    const useRelay = (
        topology.topology_state === 'stable'
        && topology.active_hub_mac
        && hubLeaseIsCurrent
        && !overrideIsCurrent
    );

    if (useRelay) {
        return {
            ...baseRoute,
            mode: 'relay',
            hub_mac: topology.active_hub_mac,
            publish_device_id: topology.active_hub_mac,
            expected_ack_origin: topology.active_hub_mac,
        };
    }

    await activateDirectFallback(redis, topology, config);
    return {
        ...baseRoute,
        mode: 'direct_fallback',
        hub_mac: topology.active_hub_mac,
        publish_device_id: targetMac,
        expected_ack_origin: targetMac,
    };
}

async function validateInboundTransport(
    redis,
    {
        deviceId,
        topicOrigin,
        transport,
    },
    config
) {
    const targetMac = normalizeMac(deviceId);
    const originMac = normalizeMac(topicOrigin);
    if (!targetMac || !originMac) {
        throw new TopologyRoutingError(
            'Telemetry source identity is missing',
            'TRANSPORT_SOURCE_MISSING'
        );
    }

    const topology = await resolveDeviceTopology(redis, targetMac);
    if (!topology) {
        if (originMac !== targetMac) {
            throw new TopologyRoutingError(
                'Legacy telemetry topic origin does not match device_id',
                'TRANSPORT_ORIGIN_MISMATCH'
            );
        }
        return {
            mode: 'direct',
            owner_id: null,
            network_id: null,
            topology_epoch: null,
            hub_mac: null,
            topic_origin: originMac,
            compatibility_legacy: true,
        };
    }

    if (!transport) {
        if (
            topology.member_count === 1
            && topology.role === 'hub'
            && originMac === targetMac
        ) {
            await renewHubLease(redis, topology, config);
            return {
                mode: 'hub',
                owner_id: topology.owner_id,
                network_id: topology.network_id,
                topology_epoch: topology.topology_epoch,
                hub_mac: targetMac,
                topic_origin: originMac,
                compatibility_legacy: true,
            };
        }
        throw new TopologyRoutingError(
            'Topology transport envelope is required',
            'TRANSPORT_ENVELOPE_REQUIRED'
        );
    }

    const mode = transport.mode;
    const transportEpoch = safeEpoch(transport.topology_epoch);
    const transportHubMac = transport.hub_mac
        ? normalizeMac(transport.hub_mac)
        : null;
    if (
        transport.network_id !== topology.network_id
        || transportEpoch !== topology.topology_epoch
    ) {
        throw new TopologyRoutingError(
            'Telemetry topology assignment is stale',
            'TOPOLOGY_EPOCH_STALE'
        );
    }

    if (mode === 'hub') {
        if (
            topology.role !== 'hub'
            || topology.active_hub_mac !== targetMac
            || originMac !== targetMac
            || (transportHubMac && transportHubMac !== targetMac)
        ) {
            throw new TopologyRoutingError(
                'Hub telemetry does not match the active Hub assignment',
                'HUB_ASSIGNMENT_MISMATCH'
            );
        }
        await renewHubLease(redis, topology, config);
    } else if (mode === 'relay') {
        if (
            topology.role !== 'node'
            || topology.topology_state !== 'stable'
            || !topology.active_hub_mac
            || transportHubMac !== topology.active_hub_mac
            || originMac !== topology.active_hub_mac
        ) {
            throw new TopologyRoutingError(
                'Relay telemetry did not originate from the active Hub',
                'RELAY_HUB_MISMATCH'
            );
        }
        await renewHubLease(redis, topology, config);
    } else if (mode === 'direct_fallback') {
        if (originMac !== targetMac || topology.role === 'hub') {
            throw new TopologyRoutingError(
                'Direct fallback must originate from the Node itself',
                'DIRECT_FALLBACK_ORIGIN_MISMATCH'
            );
        }
        const fallbackAllowed = (
            topology.topology_state !== 'stable'
            || !(await hasCurrentHubLease(redis, topology))
        );
        if (!fallbackAllowed) {
            throw new TopologyRoutingError(
                'Direct fallback rejected while the active Hub lease is healthy',
                'DIRECT_FALLBACK_NOT_ALLOWED'
            );
        }
        await activateDirectFallback(redis, topology, config);
    } else {
        throw new TopologyRoutingError(
            `Unsupported transport mode '${mode}'`,
            'TRANSPORT_MODE_INVALID'
        );
    }

    return {
        mode,
        owner_id: topology.owner_id,
        network_id: topology.network_id,
        topology_epoch: topology.topology_epoch,
        hub_mac: transportHubMac || topology.active_hub_mac,
        topic_origin: originMac,
        compatibility_legacy: false,
    };
}

async function storeCommandRoute(redis, commandId, route, config) {
    await redis.set(
        commandRouteKey(commandId),
        JSON.stringify(route),
        'EX',
        config.COMMAND_IDEMPOTENCY_TTL_SECONDS
    );
}

async function deleteCommandRoute(redis, commandId) {
    await redis.del(commandRouteKey(commandId));
}

async function validateCommandAck(
    redis,
    ack,
    topicOrigin,
    config
) {
    const route = parseJson(
        await redis.get(commandRouteKey(ack.command_id)),
        'Command route'
    );
    if (!route) {
        throw new TopologyRoutingError(
            'ACK has no matching command route',
            'COMMAND_ROUTE_NOT_FOUND'
        );
    }

    const deviceMac = normalizeMac(ack.device_id);
    const originMac = normalizeMac(topicOrigin);
    if (
        deviceMac !== normalizeMac(route.target_device_id)
        || originMac !== normalizeMac(route.expected_ack_origin)
    ) {
        throw new TopologyRoutingError(
            'ACK device or MQTT origin does not match the command route',
            'ACK_ROUTE_MISMATCH'
        );
    }

    if (route.network_id) {
        const topology = await resolveDeviceTopology(redis, deviceMac);
        if (
            !topology
            || topology.network_id !== route.network_id
            || topology.topology_epoch !== safeEpoch(route.topology_epoch)
        ) {
            throw new TopologyRoutingError(
                'ACK belongs to a stale topology epoch',
                'ACK_TOPOLOGY_STALE'
            );
        }
        if (
            route.mode === 'relay'
            && topology.active_hub_mac !== normalizeMac(route.hub_mac)
        ) {
            throw new TopologyRoutingError(
                'ACK was relayed by a Hub that is no longer active',
                'ACK_HUB_STALE'
            );
        }

        const envelope = ack.transport || ack.route;
        if (!envelope && !route.compatibility_legacy) {
            throw new TopologyRoutingError(
                'ACK topology envelope is required',
                'ACK_ENVELOPE_REQUIRED'
            );
        }
        if (envelope) {
            if (
                envelope.mode !== route.mode
                || envelope.network_id !== route.network_id
                || safeEpoch(envelope.topology_epoch) !== safeEpoch(route.topology_epoch)
                || (
                    route.hub_mac
                    && normalizeMac(envelope.hub_mac) !== normalizeMac(route.hub_mac)
                )
            ) {
                throw new TopologyRoutingError(
                    'ACK topology envelope does not match the command route',
                    'ACK_ENVELOPE_MISMATCH'
                );
            }
        }
        if (route.mode === 'relay' || route.mode === 'hub') {
            await renewHubLease(redis, topology, config);
        }
    }

    return route;
}

async function validateTopologyAck(redis, ack, topicOrigin, config) {
    const deviceMac = normalizeMac(ack.device_id);
    const originMac = normalizeMac(topicOrigin);
    if (!deviceMac || deviceMac !== originMac) {
        throw new TopologyRoutingError(
            'Topology ACK origin does not match device identity',
            'TOPOLOGY_ACK_ORIGIN_MISMATCH'
        );
    }
    const topology = await resolveDeviceTopology(redis, deviceMac);
    if (
        !topology
        || topology.role !== 'hub'
        || topology.active_hub_mac !== deviceMac
        || topology.network_id !== ack.network_id
        || topology.topology_epoch !== safeEpoch(ack.topology_epoch)
    ) {
        throw new TopologyRoutingError(
            'Topology ACK does not match the active Hub assignment',
            'TOPOLOGY_ACK_STALE'
        );
    }
    if (!['ready', 'error'].includes(ack.status)) {
        throw new TopologyRoutingError(
            'Topology ACK status is invalid',
            'TOPOLOGY_ACK_STATUS_INVALID'
        );
    }
    if (ack.status === 'ready') {
        await renewHubLease(redis, topology, config);
    }
    return topology;
}

async function markTopologyTransportOffline(redis, transport, config) {
    if (
        transport?.mode !== 'hub'
        || !transport.network_id
        || transport.topology_epoch === null
    ) {
        return;
    }
    await redis.del(hubLeaseKey(transport.network_id));
    await redis.set(
        topologyRouteKey(transport.network_id),
        JSON.stringify({
            mode: 'direct_fallback',
            topology_epoch: transport.topology_epoch,
            detected_at: new Date().toISOString(),
            reason: 'hub_reported_offline',
        }),
        'EX',
        config.DIRECT_FALLBACK_ROUTE_SECONDS
    );
}

module.exports = {
    TopologyRoutingError,
    normalizeMac,
    resolveDeviceTopology,
    resolveCommandRoute,
    validateInboundTransport,
    storeCommandRoute,
    deleteCommandRoute,
    validateCommandAck,
    validateTopologyAck,
    markTopologyTransportOffline,
    renewHubLease,
};
