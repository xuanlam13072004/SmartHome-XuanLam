const test = require('node:test');
const assert = require('node:assert/strict');
const {
    resolveOperationRoute,
    validateInboundTransport,
    storeOperationRoute,
    validateOperationAck,
    validateTopologyAck,
    markTopologyTransportOffline,
} = require('../src/services/topologyRuntime');
const { publishOperationToDevice } = require('../src/services/operationProcessor');
const { publishTopologyAssignment } = require('../src/workers/topologySubscriber');
const { CACHE_PREFIXES } = require('../../shared/constants');

class FakeRedis {
    constructor() { this.values = new Map(); }
    async get(key) { return this.values.get(key) ?? null; }
    async set(key, value, ...args) {
        if (args.includes('NX') && this.values.has(key)) return null;
        this.values.set(key, String(value));
        return 'OK';
    }
    async del(...keys) {
        let deleted = 0;
        for (const key of keys) if (this.values.delete(key)) deleted += 1;
        return deleted;
    }
    async exists(key) { return this.values.has(key) ? 1 : 0; }
}

const config = {
    HUB_LEASE_SECONDS: 15,
    DIRECT_FALLBACK_ROUTE_SECONDS: 30,
    OPERATION_IDEMPOTENCY_TTL_SECONDS: 86400,
    MQTT_CONTROL_TOPIC: 'smarthome/{device_id}/control',
    MQTT_HUB_CONTROL_TOPIC: 'smarthome/{hub_id}/hub/control',
    MQTT_TOPOLOGY_TOPIC: 'smarthome/{device_id}/topology',
    MQTT_QOS: 1,
};
const ownerId = '50000000-0000-4000-8000-000000000001';
const networkId = '60000000-0000-4000-8000-000000000001';
const hubMac = '02:20:00:00:00:01';
const nodeMac = '02:20:00:00:00:02';
const operationId = '80000000-0000-4000-8000-000000000001';

function setTopology(redis, mac, overrides = {}) {
    const value = {
        network_id: networkId,
        owner_id: ownerId,
        device_id: mac === hubMac
            ? '70000000-0000-4000-8000-000000000001'
            : '70000000-0000-4000-8000-000000000002',
        mac,
        join_rank: mac === hubMac ? 1 : 2,
        role: mac === hubMac ? 'hub' : 'node',
        active_hub_device_id: '70000000-0000-4000-8000-000000000001',
        active_hub_mac: hubMac,
        topology_epoch: 7,
        topology_state: 'stable',
        transport_mode: mac === hubMac ? 'hub' : 'relay',
        member_count: 2,
        ...overrides,
    };
    redis.values.set(`${CACHE_PREFIXES.TOPOLOGY_DEVICE}${mac}`, JSON.stringify(value));
    return value;
}

function operation(deviceId = nodeMac) {
    return {
        operation_id: operationId,
        owner_id: ownerId,
        device_id: deviceId,
        product_id: 'prod_test',
        catalog_revision: 2,
        instance_id: 'main',
        operation_name: 'set_power',
        input: { enabled: true },
        created_at: new Date().toISOString(),
        timeout_at: new Date(Date.now() + 60_000).toISOString(),
    };
}

test('an operation is never routed before backend topology is ready', async () => {
    await assert.rejects(
        resolveOperationRoute(new FakeRedis(), operation(), config),
        error => error.code === 'TOPOLOGY_NOT_READY' && error.retryable === true,
    );
});

test('a Hub receives its own operation directly through its Hub route', async () => {
    const redis = new FakeRedis();
    setTopology(redis, hubMac);
    const route = await resolveOperationRoute(redis, operation(hubMac), config);
    assert.equal(route.mode, 'hub');
    assert.equal(route.publish_device_id, hubMac);
});

test('a Node relays through a healthy Hub and falls back directly after lease loss', async () => {
    const redis = new FakeRedis();
    setTopology(redis, nodeMac);
    redis.values.set(`${CACHE_PREFIXES.HUB_LEASE}${networkId}`, JSON.stringify({
        network_id: networkId,
        hub_mac: hubMac,
        topology_epoch: 7,
    }));
    assert.equal((await resolveOperationRoute(redis, operation(), config)).mode, 'relay');
    await redis.del(`${CACHE_PREFIXES.HUB_LEASE}${networkId}`);
    const fallback = await resolveOperationRoute(redis, operation(), config);
    assert.equal(fallback.mode, 'direct_fallback');
    assert.equal(fallback.publish_device_id, nodeMac);
});

test('relay telemetry requires the active Hub, exact epoch and transport envelope', async () => {
    const redis = new FakeRedis();
    setTopology(redis, nodeMac);
    const accepted = await validateInboundTransport(redis, {
        deviceId: nodeMac,
        topicOrigin: hubMac,
        transport: {
            mode: 'relay', network_id: networkId, topology_epoch: 7, hub_mac: hubMac,
        },
    }, config);
    assert.equal(accepted.mode, 'relay');
    await assert.rejects(
        validateInboundTransport(redis, { deviceId: nodeMac, topicOrigin: hubMac }, config),
        error => error.code === 'TRANSPORT_ENVELOPE_REQUIRED',
    );
});

test('operation ACK is fenced by target, origin, route and topology epoch', async () => {
    const redis = new FakeRedis();
    setTopology(redis, nodeMac);
    const route = {
        mode: 'relay', owner_id: ownerId, target_device_id: nodeMac,
        publish_device_id: hubMac, expected_ack_origin: hubMac,
        network_id: networkId, topology_epoch: 7, hub_mac: hubMac, member_count: 2,
    };
    await storeOperationRoute(redis, operationId, route, config);
    const ack = {
        schema: 'device.operation.ack.v2',
        operation_id: operationId,
        device_id: nodeMac,
        status: 'succeeded',
        transport: {
            mode: 'relay', network_id: networkId, topology_epoch: 7, hub_mac: hubMac,
        },
    };
    assert.equal((await validateOperationAck(redis, ack, hubMac, config)).mode, 'relay');
    setTopology(redis, nodeMac, { topology_epoch: 8 });
    await assert.rejects(
        validateOperationAck(redis, ack, hubMac, config),
        error => error.code === 'ACK_TOPOLOGY_STALE',
    );
});

test('a Hub presence loss clears its lease and activates direct fallback', async () => {
    const redis = new FakeRedis();
    setTopology(redis, hubMac);
    const transport = await validateInboundTransport(redis, {
        deviceId: hubMac,
        topicOrigin: hubMac,
        transport: {
            mode: 'hub', network_id: networkId, topology_epoch: 7, hub_mac: hubMac,
        },
    }, config);
    await markTopologyTransportOffline(redis, transport, config);
    assert.equal(await redis.exists(`${CACHE_PREFIXES.HUB_LEASE}${networkId}`), 0);
    assert.equal(
        JSON.parse(await redis.get(`${CACHE_PREFIXES.TOPOLOGY_ROUTE}${networkId}`)).mode,
        'direct_fallback',
    );
});

test('relay operation payload targets the Node while publishing to the Hub topic', async () => {
    const publishes = [];
    const mqttClient = {
        publish(topic, payload, options, callback) {
            publishes.push({ topic, payload: JSON.parse(payload), options });
            callback();
        },
    };
    await publishOperationToDevice(mqttClient, operation(), {
        mode: 'relay', target_device_id: nodeMac, publish_device_id: hubMac,
        network_id: networkId, topology_epoch: 7, hub_mac: hubMac,
    }, config, { info() {} });
    assert.equal(publishes[0].topic, `smarthome/${hubMac}/hub/control`);
    assert.equal(publishes[0].payload.schema, 'device.operation.v2');
    assert.equal(publishes[0].payload.target_device_id, nodeMac);
    assert.equal(publishes[0].payload.route.topology_epoch, 7);
});

test('published topology assignments use the V2 retained contract', async () => {
    const redis = new FakeRedis();
    redis.values.set(`${CACHE_PREFIXES.TOPOLOGY_NETWORK}${networkId}`, JSON.stringify({
        network_id: networkId,
        active_hub_mac: hubMac,
        topology_epoch: 8,
        topology_state: 'electing',
        members: [
            { device_id: 'hub-id', mac: hubMac, join_rank: 1, role: 'hub' },
            { device_id: 'node-id', mac: nodeMac, join_rank: 2, role: 'node' },
        ],
    }));
    const publishes = [];
    const mqttClient = {
        publish(topic, payload, options, callback) {
            publishes.push({ topic, payload: JSON.parse(payload), options });
            callback();
        },
    };
    await publishTopologyAssignment(
        mqttClient,
        redis,
        { network_id: networkId, topology_epoch: 8 },
        config,
        { debug() {} },
    );
    assert.equal(publishes[0].payload.schema, 'device.topology.assignment.v2');
    assert.equal(publishes[0].options.retain, true);
    assert.equal(publishes[1].payload.transport_mode, 'direct_fallback');
});

test('topology ACK only accepts the current assigned Hub', async () => {
    const redis = new FakeRedis();
    const topology = setTopology(redis, hubMac, { topology_state: 'electing' });
    const accepted = await validateTopologyAck(redis, {
        device_id: hubMac,
        network_id: networkId,
        topology_epoch: 7,
        status: 'ready',
    }, hubMac, config);
    assert.equal(accepted.device_id, topology.device_id);
});
