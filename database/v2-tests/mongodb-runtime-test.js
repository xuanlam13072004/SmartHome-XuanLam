'use strict';

const assert = require('node:assert/strict');
const { MongoClient } = require('mongodb');

const { applyMongoCollectionsV2 } = require('../mongodb/v2/apply-collections');
const { seedCatalogV2 } = require('../mongodb/v2/seed-catalog');

async function expectMongoError(operation, expectedCode) {
    let caught = null;
    try {
        await operation();
    } catch (error) {
        caught = error;
    }
    assert.ok(caught, `Expected MongoDB error ${expectedCode}.`);
    assert.equal(caught.code, expectedCode);
}

async function main() {
    const uri = process.env.MONGO_URI || 'mongodb://localhost:27017';
    const dbName = process.env.MONGO_V2_CONTRACT_DB;
    if (dbName !== 'SmartHomeV2ContractTest') {
        throw new Error('MONGO_V2_CONTRACT_DB must be exactly SmartHomeV2ContractTest.');
    }

    const client = new MongoClient(uri);
    await client.connect();
    let databaseCreated = false;

    try {
        const existing = await client.db(dbName).listCollections({}, { nameOnly: true }).toArray();
        if (existing.length > 0) {
            throw new Error(`Disposable MongoDB database is not empty: ${existing.map(item => item.name).join(', ')}`);
        }

        const db = client.db(dbName);
        await applyMongoCollectionsV2(db);
        databaseCreated = true;
        await seedCatalogV2(db);

        assert.equal(await db.collection('capability_definitions').countDocuments(), 26);
        assert.equal(await db.collection('product_definitions').countDocuments(), 4);
        assert.equal(await db.collection('catalog_releases').countDocuments({ lifecycle: 'draft' }), 1);

        await db.collection('device_shadows').insertOne({
            _id: '02:00:00:00:00:01',
            owner_id: '00000000-0000-4000-8000-000000000001',
            product_id: 'prod_entrance_controller',
            catalog_revision: 1,
            state_version: 0,
            instances: {},
            diagnostics: {},
            is_online: false,
            last_seen: null,
            updated_at: new Date(),
        });

        await expectMongoError(
            () => db.collection('device_shadows').insertOne({
                _id: '02:00:00:00:00:aa',
                owner_id: 'owner',
                product_id: 'prod_entrance_controller',
                catalog_revision: 1,
                state_version: 0,
                instances: {},
                diagnostics: {},
                is_online: false,
                updated_at: new Date(),
            }),
            121,
        );

        const event = {
            event_id: 'event-1',
            device_id: '02:00:00:00:00:01',
            owner_id: '00000000-0000-4000-8000-000000000001',
            product_id: 'prod_entrance_controller',
            catalog_revision: 1,
            instance_id: 'main_lock',
            type: 'lock_changed',
            severity: 'info',
            source: 'device',
            occurred_at: new Date(),
            data: {},
        };
        await db.collection('device_events').insertOne(event);
        await expectMongoError(
            () => db.collection('device_events').insertOne({ ...event, _id: undefined }),
            11000,
        );

        await db.collection('device_telemetry').insertOne({
            metadata: {
                device_id: '02:00:00:00:00:01',
                product_id: 'prod_entrance_controller',
                catalog_revision: 1,
            },
            observed_at: new Date(),
            sequence: 1,
            instances: {},
            diagnostics: {},
        });

        await db.collection('telemetry_ingest_receipts').insertOne({
            event_id: 'telemetry-1',
            device_id: '02:00:00:00:00:01',
            received_at: new Date(),
            expires_at: new Date(Date.now() + 60_000),
        });
        await expectMongoError(
            () => db.collection('telemetry_ingest_receipts').insertOne({
                event_id: 'telemetry-1',
                device_id: '02:00:00:00:00:01',
                received_at: new Date(),
                expires_at: new Date(Date.now() + 60_000),
            }),
            11000,
        );

        process.stdout.write('MongoDB V2 runtime contract passed.\n');
    } finally {
        if (databaseCreated) await client.db(dbName).dropDatabase();
        const databases = await client.db('admin').admin().listDatabases({ nameOnly: true });
        assert.equal(databases.databases.some(item => item.name === dbName), false, 'Disposable MongoDB database was not removed.');
        await client.close();
    }
}

main().catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});
