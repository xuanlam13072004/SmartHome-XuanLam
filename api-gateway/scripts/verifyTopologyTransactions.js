const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool, Client } = require('pg');
const argon2 = require('argon2');
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
const databaseName = `smarthome_topology_tx_${Date.now()}_${crypto
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

async function connect(database) {
    const client = new Client({ ...baseConfig, database });
    await client.connect();
    return client;
}

async function expectFailure(operation, message) {
    let failed = false;
    try {
        await operation();
    } catch {
        failed = true;
    }
    assert(failed, message);
}

function configureServiceEnvironment() {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET ||= 'topology-test-secret';
    process.env.PG_HOST = baseConfig.host;
    process.env.PG_PORT = String(baseConfig.port);
    process.env.PG_DATABASE = databaseName;
    process.env.PG_USER = baseConfig.user;
    process.env.PG_PASSWORD = baseConfig.password;
    process.env.PG_SSL = 'false';
    process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017';
    process.env.MONGO_DB_NAME ||= 'TopologyTest';
    process.env.MONGO_DEVICES_COLLECTION ||= 'devices';
    process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
}

function createAppDouble(pool) {
    const shadowWrites = [];
    const collection = {
        async updateOne(filter, update, options) {
            shadowWrites.push({ filter, update, options });
            return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
        },
    };
    const logger = {
        debug() {},
        warn() {},
        error() {},
        info() {},
    };

    return {
        pg: pool,
        mongo: {
            db: {
                collection() {
                    return collection;
                },
            },
        },
        redis: {
            async del() { return 1; },
            async publish() { return 1; },
            async setex() { return 'OK'; },
        },
        catalogCache: {
            getProduct(productId) {
                if (productId !== 'topology_test_product') return undefined;
                return {
                    display_name: 'Topology Test Device',
                    default_state: { power: false },
                };
            },
        },
        log: logger,
        shadowWrites,
    };
}

async function seedFactoryDevice(client, mac, secretHash, claimed = false) {
    await client.query(
        `INSERT INTO factory_devices
            (mac, secret_key, product_id, is_claimed)
         VALUES ($1, $2, 'topology_test_product', $3)`,
        [mac, secretHash, claimed]
    );
}

async function verifyTransactions(pool, claimDevice, unpairDevice) {
    const ownerId = '50000000-0000-4000-8000-000000000001';
    const secret = 'topology-secret-123';
    const secretHash = await argon2.hash(secret);
    const networkA = 'a'.repeat(64);
    const networkB = 'b'.repeat(64);
    const networkC = 'c'.repeat(64);
    const rollbackNetwork = 'd'.repeat(64);
    const macA = '02:10:00:00:00:01';
    const macB = '02:10:00:00:00:02';
    const macC = '02:10:00:00:00:03';
    const macD = '02:10:00:00:00:04';
    const macE = '02:10:00:00:00:05';
    const macF = '02:10:00:00:00:06';
    const macG = '02:10:00:00:00:07';
    const macRollback = '02:10:00:00:00:08';
    const macLegacy = '02:10:00:00:00:09';
    const app = createAppDouble(pool);

    await pool.query(
        `INSERT INTO accounts (id, username, email, password_hash, full_name)
         VALUES ($1, 'topology-service-owner', 'topology-service@example.test',
                 'hash', 'Topology Service Owner')`,
        [ownerId]
    );
    for (const mac of [
        macA,
        macB,
        macC,
        macD,
        macE,
        macF,
        macG,
        macRollback,
    ]) {
        await seedFactoryDevice(pool, mac, secretHash);
    }
    await seedFactoryDevice(pool, macLegacy, secretHash, true);

    const claimedA = await claimDevice(app, {
        mac: macA,
        secret_key: secret,
        name: 'Device A',
        network_fingerprint: networkA,
    }, ownerId);
    assert(claimedA.topology_role === 'hub', 'First device was not elected Hub');
    assert(claimedA.join_rank === 1, 'First device did not receive join rank 1');
    assert(claimedA.topology_epoch === 1, 'First claim did not create epoch 1');

    const claimedB = await claimDevice(app, {
        mac: macB,
        secret_key: secret,
        name: 'Device B',
        network_fingerprint: networkA,
    }, ownerId);
    assert(claimedB.topology_role === 'node', 'Second device was not assigned Node');
    assert(claimedB.join_rank === 2, 'Second device did not receive join rank 2');
    assert(
        claimedB.active_hub_device_id === claimedA.id,
        'Second claim replaced the existing Hub'
    );
    assert(claimedB.topology_epoch === 2, 'Second claim did not advance epoch');

    const claimedC = await claimDevice(app, {
        mac: macC,
        secret_key: secret,
        name: 'Device C',
        network_fingerprint: networkB,
    }, ownerId);
    assert(
        claimedC.topology_role === 'hub' && claimedC.join_rank === 1,
        'A different network did not receive its own Hub'
    );
    await pool.query('DELETE FROM factory_devices WHERE mac = $1', [macC]);
    await expectFailure(
        () => unpairDevice(app, macC, ownerId),
        'Unpair unexpectedly succeeded without its factory record'
    );
    const inconsistentFactoryResult = await pool.query(
        `SELECT
            (SELECT count(*)::int FROM device_metadata WHERE mac = $1) AS devices,
            (SELECT topology_epoch
             FROM device_networks
             WHERE id = $2) AS topology_epoch`,
        [macC, claimedC.network_id]
    );
    assert(
        inconsistentFactoryResult.rows[0].devices === 1
        && Number(inconsistentFactoryResult.rows[0].topology_epoch) === 1,
        'Failed unpair did not roll back ownership and topology'
    );

    const isolatedD = await claimDevice(app, {
        mac: macD,
        secret_key: secret,
        name: 'Device D',
    }, ownerId);
    const isolatedE = await claimDevice(app, {
        mac: macE,
        secret_key: secret,
        name: 'Device E',
    }, ownerId);
    assert(
        isolatedD.network_id !== isolatedE.network_id,
        'Legacy claims without fingerprint were grouped into one network'
    );
    assert(
        isolatedD.topology_role === 'hub' && isolatedE.topology_role === 'hub',
        'Legacy isolated devices were not elected Hub of their own networks'
    );

    const concurrentClaims = await Promise.all([
        claimDevice(app, {
            mac: macF,
            secret_key: secret,
            name: 'Device F',
            network_fingerprint: networkC,
        }, ownerId),
        claimDevice(app, {
            mac: macG,
            secret_key: secret,
            name: 'Device G',
            network_fingerprint: networkC,
        }, ownerId),
    ]);
    const concurrentRanks = concurrentClaims
        .map((device) => device.join_rank)
        .sort((left, right) => left - right);
    assert(
        concurrentRanks[0] === 1 && concurrentRanks[1] === 2,
        'Concurrent claims did not receive deterministic unique ranks'
    );
    assert(
        concurrentClaims.filter((device) => device.topology_role === 'hub').length === 1,
        'Concurrent claims elected more than one Hub'
    );

    const unpairedNode = await unpairDevice(app, macB, ownerId);
    assert(!unpairedNode.hub_changed, 'Unpairing a Node unexpectedly changed Hub');
    assert(
        unpairedNode.active_hub_device_id === claimedA.id,
        'Unpairing a Node removed the current Hub'
    );
    assert(
        unpairedNode.topology_epoch === 3,
        'Unpairing a Node did not advance topology epoch'
    );

    const reclaimedB = await claimDevice(app, {
        mac: macB,
        secret_key: secret,
        name: 'Device B Reclaimed',
        network_fingerprint: networkA,
    }, ownerId);
    assert(
        reclaimedB.join_rank === 3,
        'Reclaimed device reused an old join rank'
    );

    const unpairedHub = await unpairDevice(app, macA, ownerId);
    assert(unpairedHub.hub_changed, 'Unpairing Hub did not trigger election');
    assert(
        unpairedHub.active_hub_device_id === reclaimedB.id,
        'Lowest remaining join rank was not elected Hub'
    );
    assert(
        unpairedHub.topology_state === 'electing',
        'Network was marked stable before the successor Hub acknowledged'
    );

    const emptiedNetwork = await unpairDevice(app, macB, ownerId);
    assert(emptiedNetwork.hub_changed, 'Removing the final Hub was not recorded');
    assert(
        emptiedNetwork.topology_state === 'empty'
        && emptiedNetwork.active_hub_device_id === null,
        'Network was not retained in the empty state'
    );

    const reclaimedA = await claimDevice(app, {
        mac: macA,
        secret_key: secret,
        name: 'Device A Reclaimed',
        network_fingerprint: networkA,
    }, ownerId);
    assert(
        reclaimedA.join_rank === 4,
        'Empty network reset its monotonic join rank'
    );
    assert(
        reclaimedA.topology_role === 'hub',
        'First device returning to an empty network was not elected Hub'
    );

    await expectFailure(
        () => claimDevice(app, {
            mac: macRollback,
            secret_key: secret,
            name: 'Device A Reclaimed',
            network_fingerprint: rollbackNetwork,
        }, ownerId),
        'A duplicate device name unexpectedly succeeded'
    );
    const rollbackResult = await pool.query(
        `SELECT
            (SELECT is_claimed FROM factory_devices WHERE mac = $1) AS is_claimed,
            (SELECT count(*)::int FROM device_metadata WHERE mac = $1) AS metadata_count,
            (SELECT count(*)::int
             FROM device_networks
             WHERE owner_id = $2 AND network_fingerprint = $3) AS network_count`,
        [macRollback, ownerId, rollbackNetwork]
    );
    assert(
        rollbackResult.rows[0].is_claimed === false
        && rollbackResult.rows[0].metadata_count === 0
        && rollbackResult.rows[0].network_count === 0,
        'Failed claim did not roll back factory, ownership and network data'
    );

    await pool.query(
        `INSERT INTO device_metadata
            (owner_id, mac, name, product_id, is_active)
         VALUES ($1, $2, 'Legacy Device', 'topology_test_product', true)`,
        [ownerId, macLegacy]
    );
    const legacyUnpair = await unpairDevice(app, macLegacy, ownerId);
    assert(
        legacyUnpair.network_id === null
        && legacyUnpair.topology_epoch === null,
        'Legacy device without topology could not be unpaired compatibly'
    );

    const networkAResult = await pool.query(
        `SELECT n.topology_epoch, n.next_join_rank, n.topology_state,
                hub.mac AS active_hub_mac
         FROM device_networks AS n
         LEFT JOIN device_metadata AS hub ON hub.id = n.active_hub_device_id
         WHERE n.owner_id = $1 AND n.network_fingerprint = $2`,
        [ownerId, networkA]
    );
    assert(networkAResult.rowCount === 1, 'Primary test network is missing');
    assert(
        Number(networkAResult.rows[0].topology_epoch) === 7,
        'Topology epoch sequence is not monotonic across claim/unpair'
    );
    assert(
        Number(networkAResult.rows[0].next_join_rank) === 5,
        'Next join rank was not preserved after empty/reclaim'
    );
    assert(
        networkAResult.rows[0].active_hub_mac === macA,
        'Reclaimed device is not the active Hub'
    );

    const outboxResult = await pool.query(
        `SELECT topology_epoch, reason, payload
         FROM topology_outbox
         WHERE network_id = $1
         ORDER BY topology_epoch ASC`,
        [reclaimedA.network_id]
    );
    assert(outboxResult.rowCount === 7, 'Topology outbox lost one or more changes');
    assert(
        outboxResult.rows.map((row) => Number(row.topology_epoch)).join(',') ===
            '1,2,3,4,5,6,7',
        'Topology outbox epochs contain a gap or duplicate'
    );
    assert(
        outboxResult.rows[4].reason === 'hub_unpaired'
        && outboxResult.rows[5].reason === 'network_emptied',
        'Hub replacement or empty-network reason was recorded incorrectly'
    );
    assert(
        outboxResult.rows.every(
            (row) => row.payload.topology_epoch === Number(row.topology_epoch)
        ),
        'Topology outbox payload does not match its fencing epoch'
    );

    const shadowOutboxResult = await pool.query(
        `SELECT count(*)::int AS pending
         FROM device_shadow_outbox
         WHERE processed_at IS NULL`
    );
    assert(
        shadowOutboxResult.rows[0].pending === 0,
        'Device shadow events were not dispatched by the service'
    );
    assert(app.shadowWrites.length > 0, 'MongoDB shadow dispatcher was not invoked');
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
        const {
            claimDevice,
            unpairDevice,
        } = require('../dist/modules/device/service');
        pool = new Pool({ ...baseConfig, database: databaseName, max: 10 });

        await verifyTransactions(pool, claimDevice, unpairDevice);
        console.log('PASS: claim/unpair topology transaction verification');
    } catch (error) {
        primaryError = error;
    } finally {
        if (pool) {
            try {
                await pool.end();
            } catch (cleanupError) {
                primaryError = primaryError
                    ? new AggregateError(
                        [primaryError, cleanupError],
                        'Verification failed and PostgreSQL pool cleanup also failed'
                    )
                    : cleanupError;
            }
        }
        if (databaseCreated) {
            try {
                await adminClient.query(
                    `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`
                );
                console.log('CLEAN: temporary topology transaction database removed');
            } catch (cleanupError) {
                primaryError = primaryError
                    ? new AggregateError(
                        [primaryError, cleanupError],
                        'Verification failed and temporary database cleanup also failed'
                    )
                    : cleanupError;
            }
        }
        await adminClient.end();
    }

    if (primaryError) throw primaryError;
}

main().catch((error) => {
    console.error('Topology transaction verification failed:', error);
    process.exitCode = 1;
});
