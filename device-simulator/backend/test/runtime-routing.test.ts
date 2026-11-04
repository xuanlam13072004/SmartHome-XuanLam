import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeManager } from '../src/runtime/manager';
import { parseTopologyAssignment } from '../src/runtime/topology';

const logger = {
    child: () => logger,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
} as any;

test('unpair revokes the live runtime and prevents restart from claimed registry state', async () => {
    const writes: any[] = [];
    const db = { collection: () => ({ updateOne: async (...args: any[]) => { writes.push(args); } }) };
    const manager = new RuntimeManager(logger, () => db as any);
    const mac = 'AA:00:00:00:00:01';
    let disposed = false;
    (manager as any).devices.set(mac, { dispose: async () => { disposed = true; } });
    (manager as any).assignments.set(mac, { network_id: 'network-a' });
    await manager.onTopologyMessage(mac, Buffer.alloc(0));
    assert.equal(disposed, true);
    assert.equal(manager.getDevice(mac), undefined);
    assert.equal((manager as any).assignments.has(mac), false);
    assert.equal(writes[0][1].$set.provisioning_state, 'unpaired');
    assert.equal(writes[0][1].$set.desired_state, 'offline');
    assert.ok('state_snapshot' in writes[0][1].$unset);
    assert.ok('device_id' in writes[0][1].$unset);
});

const hubAssignment = parseTopologyAssignment({
    schema: 'device.topology.assignment.v2',
    network_id: 'network-a',
    topology_epoch: 8,
    topology_state: 'stable',
    role: 'hub',
    join_rank: 1,
    active_hub_mac: 'AA:00:00:00:00:01',
    transport_mode: 'hub',
    members: [],
});

const nodeAssignment = parseTopologyAssignment({
    schema: 'device.topology.assignment.v2',
    network_id: 'network-a',
    topology_epoch: 8,
    topology_state: 'stable',
    role: 'node',
    join_rank: 2,
    active_hub_mac: 'AA:00:00:00:00:01',
    transport_mode: 'relay',
    members: [],
});

test('Node telemetry is published by the active Hub with a relay envelope', async () => {
    const manager = new RuntimeManager(logger);
    const published: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    const hub = {
        id: 'AA:00:00:00:00:01',
        runId: 'run-a',
        topology: hubAssignment,
        brokerConnected: true,
        publishBrokerMessage: async (kind: string, payload: Record<string, unknown>) => {
            published.push({ kind, payload });
        },
    };
    const node = {
        id: 'AA:00:00:00:00:02',
        runId: 'run-a',
        topology: nodeAssignment,
        effectiveTransportMode: 'relay',
        publishBrokerMessage: async () => {
            throw new Error('Node must not publish relay telemetry directly');
        },
        activateDirectFallback: async () => undefined,
    };
    (manager as any).devices.set(hub.id, hub);
    (manager as any).devices.set(node.id, node);

    await manager.publishDeviceMessage(node as any, 'telemetry', {
        device_id: node.id,
        seq: 1,
    });

    assert.equal(published.length, 1);
    assert.equal(published[0].kind, 'telemetry');
    assert.deepEqual(published[0].payload.transport, {
        mode: 'relay',
        network_id: 'network-a',
        topology_epoch: 8,
        hub_mac: hub.id,
    });
});

test('Hub operation downlink is delivered only to the Node in the same current epoch', async () => {
    const manager = new RuntimeManager(logger);
    const received: Array<{ origin: string; payload: unknown }> = [];
    const hub = {
        id: 'AA:00:00:00:00:01',
        runId: 'run-a',
        topology: hubAssignment,
    };
    const node = {
        id: 'AA:00:00:00:00:02',
        runId: 'run-a',
        topology: nodeAssignment,
        connected: true,
        receiveOperation: async (payload: Buffer, origin: string) => {
            received.push({ origin, payload: JSON.parse(payload.toString()) });
        },
    };
    (manager as any).devices.set(hub.id, hub);
    (manager as any).devices.set(node.id, node);

    const operation = Buffer.from(JSON.stringify({
        schema: 'device.operation.v2',
        operation_id: '995ee62b-25c6-4656-b198-0ea4407712cf',
        target_device_id: node.id,
        product_id: 'prod_test',
        catalog_revision: 1,
        instance_id: 'main',
        operation_name: 'set_power',
        input: { power: true },
        issued_at: new Date().toISOString(),
        timeout_at: new Date(Date.now() + 60_000).toISOString(),
        route: {
            mode: 'relay',
            network_id: 'network-a',
            topology_epoch: 8,
            hub_mac: hub.id,
        },
    }));
    await manager.deliverRelayedOperation(hub.id, operation);

    assert.equal(received.length, 1);
    assert.equal(received[0].origin, hub.id);
});

test('Node opens direct fallback transport when its assigned Hub is unavailable', async () => {
    const manager = new RuntimeManager(logger);
    const published: Array<Record<string, unknown>> = [];
    let fallbackActivated = false;
    const node = {
        id: 'AA:00:00:00:00:02',
        runId: 'run-a',
        topology: nodeAssignment,
        effectiveTransportMode: 'relay',
        activateDirectFallback: async () => {
            fallbackActivated = true;
        },
        publishBrokerMessage: async (_kind: string, payload: Record<string, unknown>) => {
            published.push(payload);
        },
    };
    (manager as any).devices.set(node.id, node);

    await manager.publishDeviceMessage(node as any, 'telemetry', {
        device_id: node.id,
        seq: 2,
    });

    assert.equal(fallbackActivated, true);
    assert.deepEqual(published[0].transport, {
        mode: 'direct_fallback',
        network_id: 'network-a',
        topology_epoch: 8,
        hub_mac: 'AA:00:00:00:00:01',
    });
});

const fakeRuntime = (id: string, brokerConnected: boolean) => {
    const applied: any[] = [];
    return {
        id,
        runId: 'run-a',
        brokerConnected,
        applied,
        topology: undefined as any,
        applyTopologyAssignment: async (assignment: any) => { applied.push(assignment); },
        refreshTransportAvailability: async () => undefined,
        dispose: async () => undefined,
    };
};

const assignmentPayload = (overrides: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({
    schema: 'device.topology.assignment.v2',
    network_id: 'network-a',
    topology_epoch: 9,
    topology_state: 'stable',
    role: 'hub',
    join_rank: 1,
    active_hub_mac: 'AA:00:00:00:00:01',
    transport_mode: 'hub',
    members: [
        { device_id: 'd1', mac: 'AA:00:00:00:00:01', join_rank: 1, role: 'hub' },
        { device_id: 'd2', mac: 'AA:00:00:00:00:02', join_rank: 2, role: 'node' },
        { device_id: 'd3', mac: 'AA:00:00:00:00:03', join_rank: 3, role: 'node' },
    ],
    ...overrides,
}));

test('Hub passes its assignment on to relay Nodes without their own broker connection', async () => {
    const db = { collection: () => ({ updateOne: async () => undefined }) };
    const manager = new RuntimeManager(logger, () => db as any);
    const hub = fakeRuntime('AA:00:00:00:00:01', true);
    const relayNode = fakeRuntime('AA:00:00:00:00:02', false);
    const directNode = fakeRuntime('AA:00:00:00:00:03', true);
    for (const device of [hub, relayNode, directNode]) (manager as any).devices.set(device.id, device);

    await manager.onTopologyMessage(hub.id, assignmentPayload());

    assert.equal(hub.applied[0].role, 'hub');
    assert.equal(relayNode.applied.length, 1);
    assert.equal(relayNode.applied[0].role, 'node');
    assert.equal(relayNode.applied[0].join_rank, 2);
    assert.equal(relayNode.applied[0].transport_mode, 'relay');
    assert.equal(relayNode.applied[0].topology_epoch, 9);
    // A Node with its own broker session reads its own retained assignment.
    assert.equal(directNode.applied.length, 0);
});

test('a relay Node missing from a newer Hub epoch is treated as unpaired', async () => {
    const writes: any[] = [];
    const db = { collection: () => ({ updateOne: async (...args: any[]) => { writes.push(args); } }) };
    const manager = new RuntimeManager(logger, () => db as any);
    const hub = fakeRuntime('AA:00:00:00:00:01', true);
    const removed = fakeRuntime('AA:00:00:00:00:04', false);
    (manager as any).devices.set(hub.id, hub);
    (manager as any).devices.set(removed.id, removed);
    (manager as any).assignments.set(removed.id, { network_id: 'network-a', topology_epoch: 8 });

    await manager.onTopologyMessage(hub.id, assignmentPayload());

    assert.equal(manager.getDevice(removed.id), undefined);
    assert.ok(writes.some(([filter, update]) => (
        filter.mac === removed.id && update.$set?.provisioning_state === 'unpaired'
    )));
});

test('broker credentials are generated once, stored encrypted and registered with the broker', async () => {
    const records = new Map<string, any>([['AA:00:00:00:00:05', { mac: 'AA:00:00:00:00:05' }]]);
    const db = { collection: () => ({
        findOne: async ({ mac }: any) => records.get(mac) || null,
        updateOne: async ({ mac }: any, update: any) => { Object.assign(records.get(mac), update.$set); },
    }) };
    const ensured: Array<[string, string]> = [];
    const revoked: string[] = [];
    const identities = () => ({
        ensureDeviceIdentity: async (mac: string, password: string) => { ensured.push([mac, password]); },
        revokeDeviceIdentity: async (mac: string) => { revoked.push(mac); },
    });
    const manager = new RuntimeManager(logger, () => db as any, identities);

    const first = await manager.resolveBrokerCredentials('aa:00:00:00:00:05');
    const again = await manager.resolveBrokerCredentials('AA:00:00:00:00:05');
    assert.equal(first.username, 'AA:00:00:00:00:05');
    assert.ok(first.password.length >= 40);
    assert.deepEqual(again, first);
    assert.equal(ensured.length, 1);
    const stored = records.get('AA:00:00:00:00:05').mqtt_secret;
    assert.ok(stored.encrypted && stored.iv && stored.authTag);
    assert.ok(!JSON.stringify(stored).includes(first.password));

    // After a restart the stored password is reused and re-registered.
    const restarted = new RuntimeManager(logger, () => db as any, identities);
    assert.deepEqual(await restarted.resolveBrokerCredentials('AA:00:00:00:00:05'), first);
    assert.equal(ensured.length, 2);
    assert.equal(ensured[1][1], first.password);

    await restarted.revokeBrokerIdentity('AA:00:00:00:00:05');
    assert.deepEqual(revoked, ['AA:00:00:00:00:05']);
});
