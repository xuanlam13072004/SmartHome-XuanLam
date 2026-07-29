import crypto from 'crypto';
import type { PoolClient } from 'pg';

type DeviceRow = {
    id: string;
    owner_id: string;
    mac: string;
    name: string;
    product_id: string;
    gateway_id: string | null;
    network_id: string | null;
    join_rank: string | number | null;
    is_active: boolean;
    created_at: Date;
    updated_at: Date;
};

type NetworkRow = {
    id: string;
    owner_id: string;
    network_fingerprint: string;
    active_hub_device_id: string | null;
    topology_epoch: string | number;
    next_join_rank: string | number;
    topology_state: 'stable' | 'degraded_direct' | 'electing' | 'empty';
};

export type TopologyMember = {
    device_id: string;
    mac: string;
    join_rank: number;
    role: 'hub' | 'node';
};

export type TopologySnapshot = {
    network_id: string;
    owner_id: string;
    active_hub_device_id: string | null;
    active_hub_mac: string | null;
    topology_epoch: number;
    topology_state: NetworkRow['topology_state'];
    members: TopologyMember[];
};

type TopologyChange = {
    type: 'claim' | 'unpair';
    device_id: string;
    mac: string;
    hub_changed: boolean;
};

function toSafeInteger(value: string | number, field: string) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
        throw new Error(`Topology field '${field}' exceeds the safe integer range`);
    }
    return parsed;
}

export function resolveNetworkFingerprint(
    networkFingerprint: string | undefined,
    mac: string
) {
    if (networkFingerprint) {
        return networkFingerprint.trim().toLowerCase();
    }

    // Backward-compatible claims receive a deterministic, device-isolated
    // network. No SSID, Wi-Fi password or modem identifier is persisted.
    return crypto
        .createHash('sha256')
        .update(`legacy-isolated-network:${mac}`)
        .digest('hex');
}

async function lockOrCreateNetwork(
    client: PoolClient,
    ownerId: string,
    networkFingerprint: string
) {
    await client.query(
        `INSERT INTO device_networks
            (owner_id, network_fingerprint, topology_state)
         VALUES ($1, $2, 'electing')
         ON CONFLICT (owner_id, network_fingerprint) DO NOTHING`,
        [ownerId, networkFingerprint]
    );

    const result = await client.query<NetworkRow>(
        `SELECT id, owner_id, network_fingerprint, active_hub_device_id,
                topology_epoch, next_join_rank, topology_state
         FROM device_networks
         WHERE owner_id = $1 AND network_fingerprint = $2
         FOR UPDATE`,
        [ownerId, networkFingerprint]
    );
    if (result.rows.length !== 1) {
        throw new Error('Unable to lock the device network');
    }
    return result.rows[0];
}

async function loadTopologySnapshot(
    client: PoolClient,
    networkId: string
): Promise<TopologySnapshot> {
    const networkResult = await client.query<NetworkRow & { active_hub_mac: string | null }>(
        `SELECT n.id, n.owner_id, n.active_hub_device_id,
                n.topology_epoch, n.topology_state,
                hub.mac AS active_hub_mac
         FROM device_networks AS n
         LEFT JOIN device_metadata AS hub
           ON hub.id = n.active_hub_device_id
          AND hub.network_id = n.id
         WHERE n.id = $1`,
        [networkId]
    );
    if (networkResult.rows.length !== 1) {
        throw new Error('Device network disappeared during topology transaction');
    }

    const network = networkResult.rows[0];
    const membersResult = await client.query<{
        id: string;
        mac: string;
        join_rank: string | number;
    }>(
        `SELECT id, mac, join_rank
         FROM device_metadata
         WHERE network_id = $1
         ORDER BY join_rank ASC, id ASC`,
        [networkId]
    );

    return {
        network_id: network.id,
        owner_id: network.owner_id,
        active_hub_device_id: network.active_hub_device_id,
        active_hub_mac: network.active_hub_mac,
        topology_epoch: toSafeInteger(network.topology_epoch, 'topology_epoch'),
        topology_state: network.topology_state,
        members: membersResult.rows.map((member) => ({
            device_id: member.id,
            mac: member.mac,
            join_rank: toSafeInteger(member.join_rank, 'join_rank'),
            role: member.id === network.active_hub_device_id ? 'hub' : 'node',
        })),
    };
}

async function recordTopologyEvent(
    client: PoolClient,
    snapshot: TopologySnapshot,
    reason: string,
    change: TopologyChange
) {
    const payload = {
        schema_version: 1,
        network_id: snapshot.network_id,
        owner_id: snapshot.owner_id,
        active_hub_device_id: snapshot.active_hub_device_id,
        active_hub_mac: snapshot.active_hub_mac,
        topology_epoch: snapshot.topology_epoch,
        topology_state: snapshot.topology_state,
        members: snapshot.members,
        change,
    };

    await client.query(
        `INSERT INTO topology_outbox
            (network_id, topology_epoch, reason, payload)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [
            snapshot.network_id,
            snapshot.topology_epoch,
            reason,
            JSON.stringify(payload),
        ]
    );
}

export async function claimTopologyMembership(
    client: PoolClient,
    input: {
        ownerId: string;
        mac: string;
        name: string;
        productId: string;
        networkFingerprint: string;
    }
) {
    const network = await lockOrCreateNetwork(
        client,
        input.ownerId,
        input.networkFingerprint
    );
    const joinRank = toSafeInteger(network.next_join_rank, 'next_join_rank');

    const insertResult = await client.query<DeviceRow>(
        `INSERT INTO device_metadata
            (owner_id, mac, name, product_id, gateway_id, network_id,
             join_rank, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NULL, $5, $6, true, NOW(), NOW())
         RETURNING id, owner_id, mac, name, product_id, gateway_id,
                   network_id, join_rank, is_active, created_at, updated_at`,
        [
            input.ownerId,
            input.mac,
            input.name,
            input.productId,
            network.id,
            joinRank,
        ]
    );
    const device = insertResult.rows[0];
    const hubChanged = network.active_hub_device_id === null;

    await client.query(
        `UPDATE device_networks
         SET active_hub_device_id = CASE
                 WHEN active_hub_device_id IS NULL THEN $2
                 ELSE active_hub_device_id
             END,
             topology_epoch = topology_epoch + 1,
             next_join_rank = next_join_rank + 1,
             topology_state = CASE
                 WHEN active_hub_device_id IS NULL THEN 'stable'
                 ELSE topology_state
             END,
             updated_at = NOW()
         WHERE id = $1`,
        [network.id, device.id]
    );

    const topology = await loadTopologySnapshot(client, network.id);
    await recordTopologyEvent(client, topology, 'device_claimed', {
        type: 'claim',
        device_id: device.id,
        mac: device.mac,
        hub_changed: hubChanged,
    });

    return {
        device: {
            ...device,
            join_rank: joinRank,
        },
        topology,
    };
}

export async function removeTopologyMembership(
    client: PoolClient,
    ownerId: string,
    mac: string
) {
    const deviceResult = await client.query<DeviceRow>(
        `SELECT id, owner_id, mac, name, product_id, gateway_id,
                network_id, join_rank, is_active, created_at, updated_at
         FROM device_metadata
         WHERE owner_id = $1 AND mac = $2
         FOR UPDATE`,
        [ownerId, mac]
    );
    if (deviceResult.rows.length === 0) {
        return null;
    }

    const device = deviceResult.rows[0];
    if (device.network_id === null) {
        await client.query('DELETE FROM device_metadata WHERE id = $1', [device.id]);
        return { device, topology: null, hubChanged: false };
    }

    const networkResult = await client.query<NetworkRow>(
        `SELECT id, owner_id, network_fingerprint, active_hub_device_id,
                topology_epoch, next_join_rank, topology_state
         FROM device_networks
         WHERE id = $1 AND owner_id = $2
         FOR UPDATE`,
        [device.network_id, ownerId]
    );
    if (networkResult.rows.length !== 1) {
        throw new Error('Device network ownership is inconsistent');
    }
    const network = networkResult.rows[0];

    await client.query('DELETE FROM device_metadata WHERE id = $1', [device.id]);

    const successorResult = await client.query<{ id: string }>(
        `SELECT id
         FROM device_metadata
         WHERE network_id = $1
         ORDER BY join_rank ASC, id ASC
         LIMIT 1`,
        [network.id]
    );
    const successorId = successorResult.rows[0]?.id ?? null;
    const networkIsEmpty = successorId === null;
    const removedActiveHub = network.active_hub_device_id === device.id;
    const hubWasMissing = network.active_hub_device_id === null;
    const hubChanged = removedActiveHub || hubWasMissing;
    const nextHubDeviceId = hubChanged
        ? successorId
        : network.active_hub_device_id;

    await client.query(
        `UPDATE device_networks
         SET active_hub_device_id = $2,
             topology_epoch = topology_epoch + 1,
             topology_state = CASE
                 WHEN $3::boolean THEN 'empty'
                 WHEN $4::boolean THEN 'stable'
                 ELSE topology_state
             END,
             updated_at = NOW()
         WHERE id = $1`,
        [network.id, nextHubDeviceId, networkIsEmpty, hubChanged]
    );

    const topology = await loadTopologySnapshot(client, network.id);
    const reason = networkIsEmpty
        ? 'network_emptied'
        : removedActiveHub
            ? 'hub_unpaired'
            : 'device_unpaired';
    await recordTopologyEvent(client, topology, reason, {
        type: 'unpair',
        device_id: device.id,
        mac: device.mac,
        hub_changed: hubChanged,
    });

    return { device, topology, hubChanged };
}
