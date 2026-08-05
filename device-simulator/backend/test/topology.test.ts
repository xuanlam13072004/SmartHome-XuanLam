import assert from 'node:assert/strict';
import test from 'node:test';
import {
    assignmentFromClaim,
    chooseNetworkCount,
    operationRouteMatchesAssignment,
    createNetworkFingerprint,
    networkIndexForDevice,
    parseTopologyAssignment,
    shouldApplyAssignment,
} from '../src/runtime/topology';

const stableHub = parseTopologyAssignment({
    schema: 'device.topology.assignment.v2',
    network_id: 'network-a',
    topology_epoch: 4,
    topology_state: 'stable',
    role: 'hub',
    join_rank: 1,
    active_hub_mac: 'AA:00:00:00:00:01',
    transport_mode: 'hub',
    members: [],
});

const stableNode = parseTopologyAssignment({
    schema: 'device.topology.assignment.v2',
    network_id: 'network-a',
    topology_epoch: 4,
    topology_state: 'stable',
    role: 'node',
    join_rank: 2,
    active_hub_mac: 'aa:00:00:00:00:01',
    transport_mode: 'relay',
    members: [],
});

test('network fingerprints are opaque, deterministic and isolated by user/network', () => {
    const first = createNetworkFingerprint('seed', 'run-a', 0, 0);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(first, createNetworkFingerprint('seed', 'run-a', 0, 0));
    assert.notEqual(first, createNetworkFingerprint('seed', 'run-a', 0, 1));
    assert.notEqual(first, createNetworkFingerprint('seed', 'run-a', 1, 0));
});

test('device distribution creates one first member per network then round-robins Nodes', () => {
    assert.equal(chooseNetworkCount(2, 5), 2);
    assert.equal(chooseNetworkCount(0, 5), 0);
    assert.deepEqual(
        [0, 1, 2, 3, 4, 5].map((index) => networkIndexForDevice(index, 3)),
        [0, 1, 2, 0, 1, 2],
    );
});

test('topology assignments normalize MAC addresses and reject stale/equivalent state', () => {
    assert.equal(stableNode.active_hub_mac, 'AA:00:00:00:00:01');
    assert.equal(shouldApplyAssignment(undefined, stableNode), true);
    assert.equal(shouldApplyAssignment(stableNode, stableNode), false);
    assert.equal(shouldApplyAssignment(stableNode, {
        ...stableNode,
        topology_epoch: 5,
    }), true);
    assert.throws(
        () => parseTopologyAssignment({
            ...stableNode,
            role: 'hub',
            transport_mode: 'relay',
        }),
        /Hub assignment must use Hub transport/,
    );
});

test('claim responses seed the runtime before the retained MQTT assignment arrives', () => {
    const assignment = assignmentFromClaim({
        network_id: 'network-a',
        join_rank: '1',
        topology_role: 'hub',
        topology_epoch: '4',
        topology_state: 'stable',
        active_hub_mac: 'aa:00:00:00:00:01',
    });
    assert.deepEqual(assignment, stableHub);
});

test('operation routes must match the exact role, network, epoch and Hub', () => {
    assert.equal(operationRouteMatchesAssignment({
        mode: 'relay',
        network_id: 'network-a',
        topology_epoch: 4,
        hub_mac: 'AA:00:00:00:00:01',
    }, stableNode, 'AA:00:00:00:00:02'), true);
    assert.equal(operationRouteMatchesAssignment({
        mode: 'relay',
        network_id: 'network-a',
        topology_epoch: 3,
        hub_mac: 'AA:00:00:00:00:01',
    }, stableNode, 'AA:00:00:00:00:02'), false);
    assert.equal(operationRouteMatchesAssignment({
        mode: 'direct_fallback',
        network_id: 'network-a',
        topology_epoch: 4,
        hub_mac: 'AA:00:00:00:00:01',
    }, stableNode, 'AA:00:00:00:00:02', 'direct_fallback'), true);
});
