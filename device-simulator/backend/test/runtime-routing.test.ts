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
