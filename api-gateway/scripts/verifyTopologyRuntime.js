const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool, Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const workspaceRoot = path.resolve(__dirname, '../..');
const schemaSql = fs.readFileSync(
    path.join(workspaceRoot, 'database/postgres/schema.sql'),
    'utf8'
);
const baseConfig = {
    host: process.env.PG_HOST || '127.0.0.1',
    port: Number.parseInt(process.env.PG_PORT || '5432', 10),
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || 'postgres',
};
const adminDatabase = process.env.PG_ADMIN_DATABASE || 'postgres';
const databaseName = `smarthome_topology_runtime_${Date.now()}_${crypto
    .randomBytes(4)
    .toString('hex')}`;

function quoteIdentifier(value) {
    if (!/^[a-z0-9_]+$/.test(value)) {
        throw new Error(`Unsafe PostgreSQL identifier: ${value}`);
    }
    return `"${value}"`;
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

class FakeRedis {
    constructor() {
        this.values = new Map();
        this.publications = [];
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

    async publish(channel, payload) {
        this.publications.push({ channel, payload: JSON.parse(payload) });
        return 1;
    }

    async eval(script, _keyCount, key, field, version, json) {
        if (script.includes("redis.call('get', KEYS[1]) == ARGV[1]")) {
            if (this.values.get(key) === field) {
                return this.values.delete(key) ? 1 : 0;
            }
            return 0;
        }
        const currentRaw = this.values.get(key);
        const current = currentRaw ? JSON.parse(currentRaw) : null;
        if (script.includes("redis.call('SET', KEYS[1]")) {
            if (current && Number(current[field]) > Number(version)) return 0;
            this.values.set(key, json);
            return 1;
        }
        if (!current || current[field] === undefined || Number(current[field]) <= Number(version)) {
            return this.values.delete(key) ? 1 : 0;
        }
        return 0;
    }

    async scan(cursor, _matchToken, pattern) {
        if (cursor !== '0') return ['0', []];
        const prefix = pattern.slice(0, -1);
        return [
            '0',
            [...this.values.keys()].filter((key) => key.startsWith(prefix)),
        ];
    }

    pipeline() {
        const actions = [];
        const pipeline = {
            set: (key, value) => {
                actions.push(() => this.set(key, value));
                return pipeline;
            },
            exists: (key) => {
                actions.push(() => this.exists(key));
                return pipeline;
            },
            exec: async () => {
                const results = [];
                for (const action of actions) {
                    try {
                        results.push([null, await action()]);
                    } catch (error) {
                        results.push([error, null]);
                    }
                }
                return results;
            },
        };
        return pipeline;
    }

    async exists(key) {
        return this.values.has(key) ? 1 : 0;
    }
}

class FakeMongoDb {
    constructor() {
        this.documents = new Map();
        this.operations = [];
    }

    collection() {
        return {
            updateOne: async (filter, update, options) => {
                this.operations.push({ filter, update, options });
                const id = filter._id;
                const existing = this.documents.get(id) || { _id: id };
                const currentEvent = Number(
                    existing.topology_outbox_event_id ?? -1
                );
                const nextEvent = Number(update.$set.topology_outbox_event_id);
                if (currentEvent < nextEvent) {
                    this.documents.set(id, {
                        ...existing,
                        ...update.$set,
                    });
                }
                return { acknowledged: true, matchedCount: 1 };
            },
        };
    }
}

async function connect(database) {
    const client = new Client({ ...baseConfig, database });
    await client.connect();
    return client;
}

function configureServiceEnvironment() {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET ||= 'topology-runtime-test-secret';
    process.env.PG_HOST = baseConfig.host;
    process.env.PG_PORT = String(baseConfig.port);
    process.env.PG_DATABASE = databaseName;
    process.env.PG_USER = baseConfig.user;
    process.env.PG_PASSWORD = baseConfig.password;
    process.env.PG_SSL = 'false';
    process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017';
    process.env.MONGO_DB_NAME ||= 'TopologyRuntimeTest';
    process.env.MONGO_DEVICES_COLLECTION = 'devices';
    process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
}

async function inTransaction(pool, operation) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await operation(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function verifyRuntime(pool, redis, mongo, modules) {
    const {
        claimTopologyMembership,
        removeTopologyMembership,
        transitionTopologyForHubFailure,
    } = modules.repository;
    const {
        dispatchTopologyOutboxEvent,
        synchronizeTopologyCache,
    } = modules.dispatcher;
    const ownerId = '90000000-0000-4000-8000-000000000001';
    const networkFingerprint = 'e'.repeat(64);
    const macA = '02:30:00:00:00:01';
    const macB = '02:30:00:00:00:02';
    const logger = {
        debug() {},
        info() {},
        warn() {},
        error() {},
    };

    await pool.query(
        `INSERT INTO accounts (id, username, email, password_hash, full_name)
         VALUES ($1, 'runtime-owner', 'runtime-owner@example.test',
                 'hash', 'Runtime Owner')`,
        [ownerId]
    );

    const claimA = await inTransaction(pool, (client) =>
        claimTopologyMembership(client, {
            ownerId,
            mac: macA,
            name: 'Runtime Device A',
            productId: 'runtime_product',
            networkFingerprint,
        })
    );
    const claimB = await inTransaction(pool, (client) =>
        claimTopologyMembership(client, {
            ownerId,
            mac: macB,
            name: 'Runtime Device B',
            productId: 'runtime_product',
            networkFingerprint,
        })
    );

    const eventRows = await pool.query(
        `SELECT id FROM topology_outbox ORDER BY id ASC`
    );
    const userDevicesKey = `user_devices:${ownerId}`;
    await redis.set(userDevicesKey, JSON.stringify([{ stale: true }]));
    await dispatchTopologyOutboxEvent(
        pool,
        redis,
        mongo,
        logger,
        Number(eventRows.rows[0].id)
    );
    await dispatchTopologyOutboxEvent(
        pool,
        redis,
        mongo,
        logger,
        Number(eventRows.rows[1].id)
    );
    assert(
        await redis.get(userDevicesKey) === null,
        'Topology update did not invalidate the cached user device list'
    );

    const networkKey = `topology:network:${claimA.topology.network_id}`;
    const deviceAKey = `topology:device:${macA}`;
    const deviceBKey = `topology:device:${macB}`;
    let networkCache = JSON.parse(await redis.get(networkKey));
    assert(networkCache.topology_epoch === 2, 'Topology cache did not reach epoch 2');
    assert(networkCache.members.length === 2, 'Topology cache lost a network member');
    assert(
        JSON.parse(await redis.get(deviceAKey)).role === 'hub'
        && JSON.parse(await redis.get(deviceBKey)).role === 'node',
        'Device topology roles were cached incorrectly'
    );

    const removal = await inTransaction(pool, (client) =>
        removeTopologyMembership(client, ownerId, macB)
    );
    const removalEvent = await pool.query(
        `SELECT id FROM topology_outbox
         WHERE topology_epoch = $1 AND network_id = $2`,
        [removal.topology.topology_epoch, removal.topology.network_id]
    );
    await dispatchTopologyOutboxEvent(
        pool,
        redis,
        mongo,
        logger,
        Number(removalEvent.rows[0].id)
    );
    assert(await redis.get(deviceBKey) === null, 'Removed device cache was not deleted');
    assert(
        await redis.get(`topology:removed:${macB}`) !== null,
        'Removed device retained-assignment tombstone was not created'
    );
    assert(
        mongo.documents.get(macB).network_id === null,
        'Removed device topology was not cleared from MongoDB shadow'
    );

    const reclaimedB = await inTransaction(pool, (client) =>
        claimTopologyMembership(client, {
            ownerId,
            mac: macB,
            name: 'Runtime Device B Reclaimed',
            productId: 'runtime_product',
            networkFingerprint,
        })
    );
    const reclaimEvent = await pool.query(
        `SELECT id FROM topology_outbox
         WHERE topology_epoch = $1 AND network_id = $2`,
        [reclaimedB.topology.topology_epoch, reclaimedB.topology.network_id]
    );
    await dispatchTopologyOutboxEvent(
        pool,
        redis,
        mongo,
        logger,
        Number(reclaimEvent.rows[0].id)
    );
    assert(
        await redis.get(`topology:removed:${macB}`) === null,
        'Reclaimed device tombstone was not removed'
    );
    const commandId = '91000000-0000-4000-8000-000000000001';
    await pool.query(
        `INSERT INTO device_commands
            (id, owner_id, mac, command, status, retry_count, event_version)
         VALUES ($1, $2, $3, $4, 'sent', 1, 3)`,
        [
            commandId,
            ownerId,
            macB,
            JSON.stringify({
                command_id: commandId,
                owner_id: ownerId,
                device_id: macB,
            }),
        ]
    );
    await pool.query(
        `INSERT INTO command_outbox
            (command_id, payload, published_at)
         VALUES ($1, $2::jsonb, NOW())`,
        [
            commandId,
            JSON.stringify({
                command_id: commandId,
                owner_id: ownerId,
                device_id: macB,
            }),
        ]
    );
    await redis.set(
        `command_route:${commandId}`,
        JSON.stringify({
            network_id: reclaimedB.topology.network_id,
            topology_epoch: reclaimedB.topology.topology_epoch,
            mode: 'relay',
        })
    );

    await redis.set(`device:online:${macB}`, '1');
    const coordinator = new modules.coordinator.TopologyCoordinator(
        pool,
        redis,
        logger
    );
    coordinator.running = true;
    await coordinator.evaluateNetwork(
        claimA.topology.network_id,
        'verification'
    );
    coordinator.running = false;
    const electingResult = await pool.query(
        `SELECT id AS network_id, active_hub_device_id,
                topology_epoch, topology_state
         FROM device_networks
         WHERE id = $1`,
        [claimA.topology.network_id]
    );
    const electing = {
        ...electingResult.rows[0],
        topology_epoch: Number(electingResult.rows[0].topology_epoch),
    };
    assert(
        electing.topology_state === 'electing'
        && electing.active_hub_device_id === reclaimedB.device.id,
        'Hub failure did not assign the selected successor'
    );
    const electionEvent = await pool.query(
        `SELECT id FROM topology_outbox
         WHERE topology_epoch = $1 AND network_id = $2`,
        [electing.topology_epoch, electing.network_id]
    );
    await redis.set(`topology:hub:lease:${electing.network_id}`, 'stale');
    await dispatchTopologyOutboxEvent(
        pool,
        redis,
        mongo,
        logger,
        Number(electionEvent.rows[0].id)
    );
    assert(
        await redis.get(`topology:route:${electing.network_id}`) !== null,
        'Election did not force direct fallback routing'
    );
    assert(
        await redis.get(`topology:hub:lease:${electing.network_id}`) === null,
        'Old Hub lease was not fenced during election'
    );
    let rerouteResult = await pool.query(
        `SELECT command.status, command.retry_count,
                outbox.published_at
         FROM device_commands AS command
         JOIN command_outbox AS outbox ON outbox.command_id = command.id
         WHERE command.id = $1`,
        [commandId]
    );
    assert(
        rerouteResult.rows[0].status === 'pending'
        && rerouteResult.rows[0].retry_count === 2
        && rerouteResult.rows[0].published_at === null,
        'Command from the old topology was not queued for reroute'
    );
    await pool.query(
        `UPDATE device_commands SET status = 'sent' WHERE id = $1`,
        [commandId]
    );
    await pool.query(
        `UPDATE command_outbox SET published_at = NOW() WHERE command_id = $1`,
        [commandId]
    );
    await redis.set(
        `command_route:${commandId}`,
        JSON.stringify({
            network_id: electing.network_id,
            topology_epoch: electing.topology_epoch,
            mode: 'direct_fallback',
        })
    );

    await redis.set(
        `topology:hub:lease:${electing.network_id}`,
        JSON.stringify({
            network_id: electing.network_id,
            hub_mac: macB,
            topology_epoch: electing.topology_epoch,
        })
    );
    coordinator.running = true;
    await coordinator.evaluateNetwork(
        electing.network_id,
        'verification_lost_ack_recovery'
    );
    coordinator.running = false;
    const stableResult = await pool.query(
        `SELECT id AS network_id, active_hub_device_id,
                topology_epoch, topology_state
         FROM device_networks
         WHERE id = $1`,
        [electing.network_id]
    );
    const stable = {
        ...stableResult.rows[0],
        topology_epoch: Number(stableResult.rows[0].topology_epoch),
    };
    assert(
        stable.topology_state === 'stable'
        && stable.active_hub_device_id === reclaimedB.device.id,
        'Ready Hub ACK did not stabilize the network'
    );
    const stableEvent = await pool.query(
        `SELECT id FROM topology_outbox
         WHERE topology_epoch = $1 AND network_id = $2`,
        [stable.topology_epoch, stable.network_id]
    );
    await dispatchTopologyOutboxEvent(
        pool,
        redis,
        mongo,
        logger,
        Number(stableEvent.rows[0].id)
    );
    assert(
        await redis.get(`topology:route:${stable.network_id}`) === null,
        'Stable topology did not clear direct fallback override'
    );
    rerouteResult = await pool.query(
        `SELECT command.status, command.retry_count,
                outbox.published_at
         FROM device_commands AS command
         JOIN command_outbox AS outbox ON outbox.command_id = command.id
         WHERE command.id = $1`,
        [commandId]
    );
    assert(
        rerouteResult.rows[0].status === 'pending'
        && rerouteResult.rows[0].retry_count === 3
        && rerouteResult.rows[0].published_at === null,
        'Command was not rerouted again when election became stable'
    );
    networkCache = JSON.parse(await redis.get(networkKey));
    assert(
        networkCache.topology_epoch === 6
        && JSON.parse(await redis.get(deviceBKey)).role === 'hub',
        'Stable topology cache did not expose the newly elected Hub'
    );
    await pool.query(
        `UPDATE topology_outbox SET processed_at = NULL WHERE id = $1`,
        [electionEvent.rows[0].id]
    );
    await dispatchTopologyOutboxEvent(
        pool,
        redis,
        mongo,
        logger,
        Number(electionEvent.rows[0].id)
    );
    assert(
        await redis.get(`topology:route:${stable.network_id}`) === null
        && JSON.parse(await redis.get(networkKey)).topology_epoch === 6,
        'Replayed stale topology event overwrote the current route'
    );

    const staleTransition = await inTransaction(pool, (client) =>
        transitionTopologyForHubFailure(client, {
            networkId: stable.network_id,
            expectedEpoch: 5,
            candidateDeviceId: claimA.device.id,
        })
    );
    assert(staleTransition === null, 'Stale election epoch was not rejected');

    const removedA = await inTransaction(pool, (client) =>
        removeTopologyMembership(client, ownerId, macA)
    );
    const removedAEvent = await pool.query(
        `SELECT id FROM topology_outbox
         WHERE network_id = $1 AND topology_epoch = $2`,
        [removedA.topology.network_id, removedA.topology.topology_epoch]
    );
    await dispatchTopologyOutboxEvent(
        pool,
        redis,
        mongo,
        logger,
        Number(removedAEvent.rows[0].id)
    );
    await redis.del(`topology:removed:${macA}`);
    redis.values.set('topology:device:STALE', '{"event_id":999}');
    await synchronizeTopologyCache(pool, redis, logger);
    assert(
        await redis.get('topology:device:STALE') === null,
        'Startup synchronization did not remove stale device topology'
    );
    assert(
        JSON.parse(await redis.get(networkKey)).topology_epoch === 7,
        'Startup synchronization did not rebuild the current topology'
    );
    assert(
        await redis.get(`topology:removed:${macA}`) !== null,
        'Startup synchronization did not rebuild durable removal tombstones'
    );

    const pending = await pool.query(
        `SELECT count(*)::int AS count
         FROM topology_outbox
         WHERE processed_at IS NULL`
    );
    assert(pending.rows[0].count === 0, 'Topology outbox retained processed events');
    assert(redis.publications.length >= 6, 'Topology changes were not published');
}

async function main() {
    const adminClient = await connect(adminDatabase);
    let databaseCreated = false;
    let pool;
    let primaryError;
    try {
        await adminClient.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
        databaseCreated = true;
        const schemaClient = await connect(databaseName);
        try {
            await schemaClient.query(schemaSql);
        } finally {
            await schemaClient.end();
        }

        configureServiceEnvironment();
        const repository = require('../dist/modules/device/topologyRepository');
        const dispatcher = require('../dist/workers/topologyOutboxDispatcher');
        const coordinator = require('../dist/workers/topologyCoordinator');
        pool = new Pool({ ...baseConfig, database: databaseName, max: 5 });
        const redis = new FakeRedis();
        const mongo = new FakeMongoDb();
        await verifyRuntime(pool, redis, mongo, {
            repository,
            dispatcher,
            coordinator,
        });
        console.log('PASS: topology dispatcher, fencing and failover verification');
    } catch (error) {
        primaryError = error;
    } finally {
        if (pool) {
            try {
                await pool.end();
            } catch (error) {
                primaryError ||= error;
            }
        }
        if (databaseCreated) {
            try {
                await adminClient.query(
                    `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`
                );
                console.log('CLEAN: temporary topology runtime database removed');
            } catch (error) {
                primaryError ||= error;
            }
        }
        await adminClient.end();
    }
    if (primaryError) throw primaryError;
}

main().catch((error) => {
    console.error('Topology runtime verification failed:', error);
    process.exitCode = 1;
});
