import crypto from 'node:crypto';
import type {
    TopologyRole,
    TopologyState,
    TransportMode,
} from '../domain/registry';

export interface TopologyMember {
    device_id: string;
    mac: string;
    join_rank: number;
    role: TopologyRole;
}

export interface TopologyAssignment {
    schema_version: number;
    network_id: string;
    topology_epoch: number;
    topology_state: TopologyState;
    role: TopologyRole;
    join_rank: number;
    active_hub_mac: string | null;
    transport_mode: TransportMode;
    members: TopologyMember[];
    issued_at?: string;
}

export interface CommandRoute {
    mode: TransportMode | 'direct';
    network_id: string | null;
    topology_epoch: number | null;
    hub_mac: string | null;
}

export interface TransportEnvelope {
    mode: TransportMode;
    network_id: string;
    topology_epoch: number;
    hub_mac: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const normalizeMac = (value: unknown): string | null => {
    if (typeof value !== 'string' || !value.trim()) return null;
    return value.trim().toUpperCase();
};

const safeInteger = (value: unknown): number | null => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

export const createNetworkFingerprint = (
    seed: string,
    runId: string,
    userIndex: number,
    networkIndex: number,
): string => crypto
    .createHash('sha256')
    .update(`${seed}\0${runId}\0${userIndex}\0${networkIndex}`)
    .digest('hex');

export const chooseNetworkCount = (
    targetDeviceCount: number,
    configuredCount: number,
): number => targetDeviceCount === 0
    ? 0
    : Math.max(1, Math.min(targetDeviceCount, configuredCount));

export const networkIndexForDevice = (
    deviceIndex: number,
    networkCount: number,
): number => {
    if (!Number.isSafeInteger(deviceIndex) || deviceIndex < 0) {
        throw new Error('deviceIndex must be a non-negative integer');
    }
    if (!Number.isSafeInteger(networkCount) || networkCount < 1) {
        throw new Error('networkCount must be a positive integer');
    }
    return deviceIndex % networkCount;
};

export const parseTopologyAssignment = (input: unknown): TopologyAssignment => {
    if (!isRecord(input)) throw new Error('Topology assignment must be a JSON object');
    const networkId = typeof input.network_id === 'string' ? input.network_id.trim() : '';
    const epoch = safeInteger(input.topology_epoch);
    const joinRank = safeInteger(input.join_rank);
    const topologyState = input.topology_state;
    const role = input.role;
    const transportMode = input.transport_mode;
    const activeHubMac = input.active_hub_mac === null
        ? null
        : normalizeMac(input.active_hub_mac);

    if (!networkId) throw new Error('Topology assignment network_id is required');
    if (epoch === null) throw new Error('Topology assignment epoch is invalid');
    if (joinRank === null) throw new Error('Topology assignment join_rank is invalid');
    if (!['stable', 'degraded_direct', 'electing', 'empty'].includes(String(topologyState))) {
        throw new Error('Topology assignment state is invalid');
    }
    if (!['hub', 'node'].includes(String(role))) {
        throw new Error('Topology assignment role is invalid');
    }
    if (!['hub', 'relay', 'direct_fallback'].includes(String(transportMode))) {
        throw new Error('Topology assignment transport_mode is invalid');
    }
    if (role === 'hub' && transportMode !== 'hub') {
        throw new Error('Hub assignment must use Hub transport');
    }
    if (role === 'node' && transportMode === 'hub') {
        throw new Error('Node assignment cannot use Hub transport');
    }

    const members = Array.isArray(input.members)
        ? input.members.map((member): TopologyMember => {
            if (!isRecord(member)) throw new Error('Topology member is invalid');
            const memberDeviceId = typeof member.device_id === 'string'
                ? member.device_id.trim()
                : '';
            const memberMac = normalizeMac(member.mac);
            const memberJoinRank = safeInteger(member.join_rank);
            const memberRole = member.role;
            if (
                !memberDeviceId
                || !memberMac
                || memberJoinRank === null
                || !['hub', 'node'].includes(String(memberRole))
            ) {
                throw new Error('Topology member is invalid');
            }
            return {
                device_id: memberDeviceId,
                mac: memberMac,
                join_rank: memberJoinRank,
                role: memberRole as TopologyRole,
            };
        })
        : [];

    return {
        schema_version: safeInteger(input.schema_version) ?? 1,
        network_id: networkId,
        topology_epoch: epoch,
        topology_state: topologyState as TopologyState,
        role: role as TopologyRole,
        join_rank: joinRank,
        active_hub_mac: activeHubMac,
        transport_mode: transportMode as TransportMode,
        members,
        ...(typeof input.issued_at === 'string' ? { issued_at: input.issued_at } : {}),
    };
};

export const assignmentFromClaim = (device: {
    network_id?: string | null;
    join_rank?: number | string | null;
    topology_role?: TopologyRole;
    topology_epoch?: number | string | null;
    topology_state?: TopologyState;
    active_hub_mac?: string | null;
}): TopologyAssignment | undefined => {
    if (
        !device.network_id
        || device.join_rank === null
        || device.join_rank === undefined
        || device.topology_epoch === null
        || device.topology_epoch === undefined
        || !device.topology_role
        || !device.topology_state
    ) {
        return undefined;
    }
    const role = device.topology_role;
    return parseTopologyAssignment({
        schema_version: 1,
        network_id: device.network_id,
        join_rank: Number(device.join_rank),
        topology_epoch: Number(device.topology_epoch),
        topology_state: device.topology_state,
        role,
        active_hub_mac: device.active_hub_mac ?? null,
        transport_mode: role === 'hub'
            ? 'hub'
            : device.topology_state === 'stable' ? 'relay' : 'direct_fallback',
        members: [],
    });
};

export const shouldApplyAssignment = (
    current: TopologyAssignment | undefined,
    incoming: TopologyAssignment,
): boolean => !current
    || current.network_id !== incoming.network_id
    || incoming.topology_epoch > current.topology_epoch
    || (
        incoming.topology_epoch === current.topology_epoch
        && (
            incoming.topology_state !== current.topology_state
            || incoming.role !== current.role
            || incoming.transport_mode !== current.transport_mode
            || incoming.active_hub_mac !== current.active_hub_mac
        )
    );

export const transportEnvelopeFor = (
    assignment: TopologyAssignment,
    effectiveMode: TransportMode = assignment.transport_mode,
): TransportEnvelope => ({
    mode: effectiveMode,
    network_id: assignment.network_id,
    topology_epoch: assignment.topology_epoch,
    hub_mac: assignment.active_hub_mac,
});

export const commandRouteMatchesAssignment = (
    route: CommandRoute,
    assignment: TopologyAssignment | undefined,
    targetMac: string,
    effectiveMode?: TransportMode,
): boolean => {
    if (!assignment) return route.mode === 'direct';
    const expectedMode = effectiveMode || assignment.transport_mode;
    if (
        route.mode !== expectedMode
        || route.network_id !== assignment.network_id
        || Number(route.topology_epoch) !== assignment.topology_epoch
    ) {
        return false;
    }
    if (route.mode === 'hub') {
        return assignment.role === 'hub'
            && normalizeMac(route.hub_mac) === normalizeMac(targetMac);
    }
    if (route.mode === 'relay') {
        return assignment.role === 'node'
            && normalizeMac(route.hub_mac) === assignment.active_hub_mac;
    }
    return assignment.role === 'node'
        && (
            route.hub_mac === null
            || normalizeMac(route.hub_mac) === assignment.active_hub_mac
        );
};
