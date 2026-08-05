const { CACHE_PREFIXES, REDIS_CHANNELS } = require('../../../shared/constants');

function publishAsync(mqttClient, topic, payload, options) {
    return new Promise((resolve, reject) => {
        mqttClient.publish(topic, payload, options, (error) => {
            if (error) reject(error);
            else resolve();
        });
    });
}

function assignmentTopic(config, mac) {
    return config.MQTT_TOPOLOGY_TOPIC.replace('{device_id}', mac);
}

function assignmentTransportMode(member, topologyState) {
    if (member.role === 'hub') return 'hub';
    return topologyState === 'stable' ? 'relay' : 'direct_fallback';
}

async function publishTopologyAssignment(
    mqttClient,
    redis,
    payload,
    config,
    logger
) {
    const cacheRaw = await redis.get(
        `${CACHE_PREFIXES.TOPOLOGY_NETWORK}${payload.network_id}`
    );
    if (!cacheRaw) return;
    const current = JSON.parse(cacheRaw);
    if (Number(current.topology_epoch) !== Number(payload.topology_epoch)) {
        logger.debug(
            {
                network_id: payload.network_id,
                event_epoch: payload.topology_epoch,
                current_epoch: current.topology_epoch,
            },
            'Stale topology Pub/Sub event ignored'
        );
        return;
    }

    for (const member of current.members || []) {
        const assignment = {
            schema: 'device.topology.assignment.v2',
            network_id: current.network_id,
            topology_epoch: Number(current.topology_epoch),
            topology_state: current.topology_state,
            role: member.role,
            join_rank: Number(member.join_rank),
            active_hub_mac: current.active_hub_mac,
            transport_mode: assignmentTransportMode(
                member,
                current.topology_state
            ),
            members: current.members.map((item) => ({
                device_id: item.device_id,
                mac: item.mac,
                join_rank: Number(item.join_rank),
                role: item.role,
            })),
            issued_at: new Date().toISOString(),
        };
        await publishAsync(
            mqttClient,
            assignmentTopic(config, member.mac),
            JSON.stringify(assignment),
            { qos: config.MQTT_QOS, retain: true }
        );
    }

    const removedMac = current.change?.type === 'unpair'
        ? current.change.mac
        : null;
    if (
        removedMac
        && !(current.members || []).some(member => member.mac === removedMac)
    ) {
        // Empty retained payload clears the removed device's old assignment.
        await publishAsync(
            mqttClient,
            assignmentTopic(config, removedMac),
            '',
            { qos: config.MQTT_QOS, retain: true }
        );
        await redis.del(
            `${CACHE_PREFIXES.TOPOLOGY_REMOVED}${removedMac}`
        );
    }
}

async function scanNetworkCache(redis) {
    const values = [];
    let cursor = '0';
    do {
        const [nextCursor, keys] = await redis.scan(
            cursor,
            'MATCH',
            `${CACHE_PREFIXES.TOPOLOGY_NETWORK}*`,
            'COUNT',
            200
        );
        cursor = nextCursor;
        if (keys.length > 0) {
            const cached = await redis.mget(...keys);
            values.push(...cached.filter(Boolean));
        }
    } while (cursor !== '0');
    return values;
}

async function clearRetainedRemovalTombstones(clients, config, logger) {
    let cursor = '0';
    do {
        const [nextCursor, keys] = await clients.redis.scan(
            cursor,
            'MATCH',
            `${CACHE_PREFIXES.TOPOLOGY_REMOVED}*`,
            'COUNT',
            200
        );
        cursor = nextCursor;
        for (const key of keys) {
            const raw = await clients.redis.get(key);
            if (!raw) continue;
            const tombstone = JSON.parse(raw);
            if (!tombstone.mac) continue;
            await publishAsync(
                clients.mqttClient,
                assignmentTopic(config, tombstone.mac),
                '',
                { qos: config.MQTT_QOS, retain: true }
            );
            await clients.redis.del(key);
            logger.debug(
                { mac: tombstone.mac },
                'Cleared retained topology assignment for removed device'
            );
        }
    } while (cursor !== '0');
}

async function startTopologySubscriber(clients, config, logger) {
    const redisSub = clients.redis.duplicate();
    await redisSub.connect().catch(() => undefined);
    await redisSub.subscribe(
        REDIS_CHANNELS.TOPOLOGY_UPDATED,
        REDIS_CHANNELS.TOPOLOGY_REMOVED
    );

    const publish = async (raw) => {
        try {
            const payload = JSON.parse(raw);
            await publishTopologyAssignment(
                clients.mqttClient,
                clients.redis,
                payload,
                config,
                logger
            );
        } catch (error) {
            logger.error({ error }, 'Failed to publish topology assignment');
        }
    };

    redisSub.on('message', (channel, raw) => {
        if (channel === REDIS_CHANNELS.TOPOLOGY_UPDATED) {
            void publish(raw);
        } else if (channel === REDIS_CHANNELS.TOPOLOGY_REMOVED) {
            void (async () => {
                try {
                    const tombstone = JSON.parse(raw);
                    if (!tombstone.mac) return;
                    await publishAsync(
                        clients.mqttClient,
                        assignmentTopic(config, tombstone.mac),
                        '',
                        { qos: config.MQTT_QOS, retain: true }
                    );
                    await clients.redis.del(
                        `${CACHE_PREFIXES.TOPOLOGY_REMOVED}${tombstone.mac}`
                    );
                } catch (error) {
                    logger.error(
                        { error },
                        'Failed to clear removed topology assignment'
                    );
                }
            })();
        }
    });

    // Retained assignments are rebuilt after worker/MQTT restart.
    const cachedTopologies = await scanNetworkCache(clients.redis);
    for (const raw of cachedTopologies) {
        await publish(raw);
    }
    await clearRetainedRemovalTombstones(clients, config, logger);

    logger.info(
        { networks: cachedTopologies.length },
        'Topology assignment subscriber ready'
    );
    return async () => {
        await redisSub.quit().catch(() => redisSub.disconnect());
    };
}

module.exports = {
    startTopologySubscriber,
    publishTopologyAssignment,
    assignmentTransportMode,
};
