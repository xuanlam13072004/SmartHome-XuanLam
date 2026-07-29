const test = require('node:test');
const assert = require('node:assert/strict');
const {
    resolveCommandRoute,
    validateInboundTransport,
    storeCommandRoute,
    validateCommandAck,
    validateTopologyAck,
    markTopologyTransportOffline,
} = require('../src/services/topologyRuntime');
const {
    publishCommandToDevice,
} = require('../src/services/commandProcessor');
const {
    publishTopologyAssignment,
} = require('../src/workers/topologySubscriber');
const { CACHE_PREFIXES } = require('../../shared/constants');

class FakeRedis {
    constructor() {
        this.values = new Map();
    }

    async get(key) {
        return this.values.get(key) ?? null;
    }

    async set(key, value, ...args) {
        if (args.includes('NX') && this.values.has(key)) return null;
        this.values.set(key, String(value));
        return 'OK';
    }

    async del(...keys) {
        let deleted = 0;
        for (const key of keys) {
            if (this.values.delete(key)) deleted += 1;
        }
        return deleted;
    }

    async exists(key) {
        return this.values.has(key) ? 1 : 0;
    }
}

const config = {
    HUB_LEASE_SECONDS: 15,
    DIRECT_FALLBACK_ROUTE_SECONDS: 30,
    COMMAND_IDEMPOTENCY_TTL_SECONDS: 86400,
    MQTT_CONTROL_TOPIC: 'smarthome/{device_id}/control',
    MQTT_HUB_CONTROL_TOPIC: 'smarthome/{hub_id}/hub/control',
    MQTT_TOPOLOGY_TOPIC: 'smarthome/{device_id}/topology',
    MQTT_QOS: 1,
};
const ownerId = '50000000-0000-4000-8000-000000000001';
const networkId = '60000000-0000-4000-8000-000000000001';
const hubMac = '02:20:00:00:00:01';
const nodeMac = '02:20:00:00:00:02';

function setTopology(redis, mac, overrides = {}) {
    const value = {
        event_id: 10,
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
    redis.values.set(
        `${CACHE_PREFIXES.TOPOLOGY_DEVICE}${mac}`,
        JSON.stringify(value)
    );
    return value;
}

function command(deviceId = nodeMac) {
    return {
        command_id: '80000000-0000-4000-8000-000000000001',
        owner_id: ownerId,
        device_id: deviceId,
        capability_id: 'switch',
        action: 'setPower',
        instance: 'main',
        payload: { power: true },
    };
}

test('legacy device without topology remains direct-compatible', async () => {
    const redis = new FakeRedis();
    const route = await resolveCommandRoute(redis, command(nodeMac), config);
    assert.equal(route.mode, 'direct');
    assert.equal(route.publish_device_id, nodeMac);

    const transport = await validateInboundTransport(redis, {
        deviceId: nodeMac,
        topicOrigin: nodeMac,
    }, config);
    assert.equal(transport.mode, 'direct');
    await assert.rejects(
        validateInboundTransport(redis, {
            deviceId: nodeMac,
            topicOrigin: hubMac,
        }, config),
        (error) => error.code === 'TRANSPORT_ORIGIN_MISMATCH'
    );
});

test('single-member legacy topology routes directly to its Hub', async () => {
    const redis = new FakeRedis();
    setTopology(redis, hubMac, { member_count: 1 });

    const route = await resolveCommandRoute(redis, command(hubMac), config);
    assert.equal(route.mode, 'hub');
    assert.equal(route.compatibility_legacy, true);

    const transport = await validateInboundTransport(redis, {
        deviceId: hubMac,
        topicOrigin: hubMac,
    }, config);
    assert.equal(transport.mode, 'hub');
    assert.equal(
        await redis.exists(`${CACHE_PREFIXES.HUB_LEASE}${networkId}`),
        1
    );
});

test('Node command relays only while the current Hub lease is healthy', async () => {
    const redis = new FakeRedis();
    setTopology(redis, nodeMac);
    redis.values.set(
        `${CACHE_PREFIXES.HUB_LEASE}${networkId}`,
        JSON.stringify({
            network_id: networkId,
            hub_mac: hubMac,
            topology_epoch: 7,
        })
    );

    const relayRoute = await resolveCommandRoute(redis, command(), config);
    assert.equal(relayRoute.mode, 'relay');
    assert.equal(relayRoute.publish_device_id, hubMac);

    await redis.del(`${CACHE_PREFIXES.HUB_LEASE}${networkId}`);
    const fallbackRoute = await resolveCommandRoute(redis, command(), config);
    assert.equal(fallbackRoute.mode, 'direct_fallback');
    assert.equal(fallbackRoute.publish_device_id, nodeMac);
    assert.equal(
        await redis.exists(`${CACHE_PREFIXES.TOPOLOGY_ROUTE}${networkId}`),
        1
    );
});

test('relay telemetry requires the active Hub and exact topology epoch', async () => {
    const redis = new FakeRedis();
    setTopology(redis, nodeMac);
    const accepted = await validateInboundTransport(redis, {
        deviceId: nodeMac,
        topicOrigin: hubMac,
        transport: {
            mode: 'relay',
            network_id: networkId,
            topology_epoch: 7,
            hub_mac: hubMac,
        },
    }, config);
    assert.equal(accepted.mode, 'relay');

    await assert.rejects(
        validateInboundTransport(redis, {
            deviceId: nodeMac,
            topicOrigin: '02:20:00:00:00:09',
            transport: {
                mode: 'relay',
                network_id: networkId,
                topology_epoch: 7,
                hub_mac: '02:20:00:00:00:09',
            },
        }, config),
        (error) => error.code === 'RELAY_HUB_MISMATCH'
    );
    await assert.rejects(
        validateInboundTransport(redis, {
            deviceId: nodeMac,
            topicOrigin: hubMac,
            transport: {
                mode: 'relay',
                network_id: networkId,
                topology_epoch: 6,
                hub_mac: hubMac,
            },
        }, config),
        (error) => error.code === 'TOPOLOGY_EPOCH_STALE'
    );
});

test('direct fallback is accepted only after Hub lease loss', async () => {
    const redis = new FakeRedis();
    setTopology(redis, nodeMac);
    redis.values.set(
        `${CACHE_PREFIXES.HUB_LEASE}${networkId}`,
        JSON.stringify({ hub_mac: hubMac, topology_epoch: 7 })
    );
    const message = {
        deviceId: nodeMac,
        topicOrigin: nodeMac,
        transport: {
            mode: 'direct_fallback',
            network_id: networkId,
            topology_epoch: 7,
            hub_mac: hubMac,
        },
    };
    await assert.rejects(
        validateInboundTransport(redis, message, config),
        (error) => error.code === 'DIRECT_FALLBACK_NOT_ALLOWED'
    );
    await redis.del(`${CACHE_PREFIXES.HUB_LEASE}${networkId}`);
    const accepted = await validateInboundTransport(redis, message, config);
    assert.equal(accepted.mode, 'direct_fallback');
});

test('command ACK is fenced by target, Hub and topology epoch', async () => {
    const redis = new FakeRedis();
    setTopology(redis, nodeMac);
    const route = {
        mode: 'relay',
        owner_id: ownerId,
        target_device_id: nodeMac,
        publish_device_id: hubMac,
        expected_ack_origin: hubMac,
        network_id: networkId,
        topology_epoch: 7,
        hub_mac: hubMac,
        member_count: 2,
        compatibility_legacy: false,
    };
    await storeCommandRoute(redis, command().command_id, route, config);

    const ack = {
        command_id: command().command_id,
        device_id: nodeMac,
        status: 'success',
        transport: {
            mode: 'relay',
            network_id: networkId,
            topology_epoch: 7,
            hub_mac: hubMac,
        },
    };
    assert.equal(
        (await validateCommandAck(redis, ack, hubMac, config)).mode,
        'relay'
    );
    await assert.rejects(
        validateCommandAck(redis, { ...ack, transport: undefined }, hubMac, config),
        (error) => error.code === 'ACK_ENVELOPE_REQUIRED'
    );

    setTopology(redis, nodeMac, { topology_epoch: 8 });
    await assert.rejects(
        validateCommandAck(redis, ack, hubMac, config),
        (error) => error.code === 'ACK_TOPOLOGY_STALE'
    );
});

test('topology ACK only accepts the currently assigned Hub', async () => {
    const redis = new FakeRedis();
    const topology = setTopology(redis, hubMac, {
        topology_state: 'electing',
        transport_mode: 'direct_fallback',
    });
    const accepted = await validateTopologyAck(redis, {
        device_id: hubMac,
        network_id: networkId,
        topology_epoch: 7,
        status: 'ready',
    }, hubMac, config);
    assert.equal(accepted.device_id, topology.device_id);

    await assert.rejects(
        validateTopologyAck(redis, {
            device_id: hubMac,
            network_id: networkId,
            topology_epoch: 6,
            status: 'ready',
        }, hubMac, config),
        (error) => error.code === 'TOPOLOGY_ACK_STALE'
    );
});

test('Hub offline report removes lease and activates direct fallback', async () => {
    const redis = new FakeRedis();
    setTopology(redis, hubMac);
    const transport = await validateInboundTransport(redis, {
        deviceId: hubMac,
        topicOrigin: hubMac,
        transport: {
            mode: 'hub',
            network_id: networkId,
            topology_epoch: 7,
            hub_mac: hubMac,
        },
    }, config);
    assert.equal(
        await redis.exists(`${CACHE_PREFIXES.HUB_LEASE}${networkId}`),
        1
    );
    await markTopologyTransportOffline(redis, transport, config);
    assert.equal(
        await redis.exists(`${CACHE_PREFIXES.HUB_LEASE}${networkId}`),
        0
    );
    assert.equal(
        JSON.parse(
            await redis.get(`${CACHE_PREFIXES.TOPOLOGY_ROUTE}${networkId}`)
        ).mode,
        'direct_fallback'
    );
});

test('relay command payload targets Node while publishing to Hub topic', async () => {
    const publishes = [];
    const mqttClient = {
        publish(topic, payload, options, callback) {
            publishes.push({ topic, payload: JSON.parse(payload), options });
            callback();
        },
    };
    const logger = { debug() {}, info() {}, error() {} };
    await publishCommandToDevice(
        mqttClient,
        command(),
        {
            mode: 'relay',
            target_device_id: nodeMac,
            publish_device_id: hubMac,
            network_id: networkId,
            topology_epoch: 7,
            hub_mac: hubMac,
        },
        config,
        logger
    );
    assert.equal(publishes[0].topic, `smarthome/${hubMac}/hub/control`);
    assert.equal(publishes[0].payload.target_device_id, nodeMac);
    assert.equal(publishes[0].payload.route.topology_epoch, 7);
});

test('electing topology keeps candidate Hub direct and Nodes in fallback', async () => {
    const redis = new FakeRedis();
    const removedMac = '02:20:00:00:00:09';
    redis.values.set(
        `${CACHE_PREFIXES.TOPOLOGY_NETWORK}${networkId}`,
        JSON.stringify({
            network_id: networkId,
            owner_id: ownerId,
            active_hub_device_id: '70000000-0000-4000-8000-000000000001',
            active_hub_mac: hubMac,
            topology_epoch: 8,
            topology_state: 'electing',
            members: [
                {
                    device_id: '70000000-0000-4000-8000-000000000001',
                    mac: hubMac,
                    join_rank: 1,
                    role: 'hub',
                },
                {
                    device_id: '70000000-0000-4000-8000-000000000002',
                    mac: nodeMac,
                    join_rank: 2,
                    role: 'node',
                },
            ],
            change: {
                type: 'unpair',
                mac: removedMac,
            },
        })
    );
    redis.values.set(
        `${CACHE_PREFIXES.TOPOLOGY_REMOVED}${removedMac}`,
        '{"event_id":12}'
    );
    const publishes = [];
    const mqttClient = {
        publish(topic, payload, options, callback) {
            publishes.push({
                topic,
                payload: payload ? JSON.parse(payload) : null,
                options,
            });
            callback();
        },
    };
    const logger = { debug() {} };
    await publishTopologyAssignment(
        mqttClient,
        redis,
        {
            network_id: networkId,
            topology_epoch: 8,
        },
        config,
        logger
    );
    const hubAssignment = publishes.find(
        (entry) => entry.topic === `smarthome/${hubMac}/topology`
    );
    const nodeAssignment = publishes.find(
        (entry) => entry.topic === `smarthome/${nodeMac}/topology`
    );
    assert.equal(hubAssignment.payload.transport_mode, 'hub');
    assert.equal(nodeAssignment.payload.transport_mode, 'direct_fallback');
    assert.equal(
        publishes.find(
            (entry) => entry.topic === `smarthome/${removedMac}/topology`
        ).payload,
        null
    );
    assert.equal(
        await redis.get(`${CACHE_PREFIXES.TOPOLOGY_REMOVED}${removedMac}`),
        null
    );
});
