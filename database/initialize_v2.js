'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { MongoClient } = require('mongodb');

const { applyMongoCollectionsV2 } = require('./mongodb/v2/apply-collections');
const { seedCatalogV2 } = require('./mongodb/v2/seed-catalog');

function assertInitializationGate() {
    if (process.env.ALLOW_V2_DATABASE_INITIALIZATION !== 'true') {
        throw new Error('ALLOW_V2_DATABASE_INITIALIZATION=true is required.');
    }
}

const POSTGRES_SCHEMA_VERSION = 201;
const REQUIRED_POSTGRES_TABLES = [
    'accounts',
    'user_sessions',
    'factory_devices',
    'device_networks',
    'device_metadata',
    'device_memberships',
    'device_operations',
    'operation_outbox',
    'device_resource_sessions',
    'device_credentials',
    'credential_jobs',
    'credential_outbox',
    'device_shadow_outbox',
    'topology_outbox',
];

const ALLOWED_MONGO_COLLECTIONS = new Set([
    'catalog_releases',
    'capability_definitions',
    'product_definitions',
    'device_shadows',
    'device_telemetry',
    'device_events',
    'device_incidents',
    'active_operations',
    'telemetry_ingest_receipts',
]);

async function initializePostgres() {
    const client = new Client({
        host: process.env.PG_HOST,
        port: Number(process.env.PG_PORT || 5432),
        database: process.env.PG_DATABASE,
        user: process.env.PG_USER,
        password: process.env.PG_PASSWORD,
        ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : false,
    });
    await client.connect();
    try {
        const result = await client.query(
            `SELECT table_name
               FROM information_schema.tables
              WHERE table_schema = 'public'
                AND table_type = 'BASE TABLE'`,
        );
        const existingTables = result.rows.map(row => row.table_name).sort();
        if (existingTables.length > 0) {
            if (!existingTables.includes('schema_migrations')) {
                throw new Error(
                    `PostgreSQL contains an incompatible schema: ${existingTables.join(', ')}. `
                    + 'Clear the configured PostgreSQL data directory before starting the new architecture.',
                );
            }

            const version = await client.query(
                'SELECT 1 FROM public.schema_migrations WHERE version = $1',
                [POSTGRES_SCHEMA_VERSION],
            );
            const missing = REQUIRED_POSTGRES_TABLES.filter(table => !existingTables.includes(table));
            if (version.rows.length !== 1 || missing.length > 0) {
                throw new Error(
                    `PostgreSQL schema is incomplete or incompatible. Missing: ${missing.join(', ') || 'none'}. `
                    + 'Clear the configured PostgreSQL data directory and initialize again.',
                );
            }
            return { initialized: false, schemaVersion: POSTGRES_SCHEMA_VERSION };
        }

        const schema = fs.readFileSync(path.join(__dirname, 'postgres/schema_v2.sql'), 'utf8');
        await client.query(schema);
        return { initialized: true, schemaVersion: POSTGRES_SCHEMA_VERSION };
    } finally {
        await client.end();
    }
}

async function initializeMongo() {
    const client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    try {
        const db = client.db(process.env.MONGO_DB_NAME);
        const existing = await db.listCollections({}, { nameOnly: true }).toArray();
        const unexpected = existing
            .map(item => item.name)
            .filter(name => !name.startsWith('system.'))
            .filter(name => !ALLOWED_MONGO_COLLECTIONS.has(name));
        if (unexpected.length > 0) {
            throw new Error(
                `MongoDB contains incompatible collections: ${unexpected.sort().join(', ')}. `
                + 'Clear the configured MongoDB data directory before starting the new architecture.',
            );
        }
        await applyMongoCollectionsV2(db);
        await seedCatalogV2(db);
        return { initialized: existing.length === 0 };
    } finally {
        await client.close();
    }
}

async function main() {
    assertInitializationGate();
    for (const required of ['PG_HOST', 'PG_DATABASE', 'PG_USER', 'PG_PASSWORD', 'MONGO_URI', 'MONGO_DB_NAME']) {
        if (!process.env[required]) throw new Error(`${required} is required.`);
    }

    await initializePostgres();
    await initializeMongo();
    process.stdout.write('SmartHome database contract is ready.\n');
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`${error.stack || error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    assertInitializationGate,
    ALLOWED_MONGO_COLLECTIONS,
    POSTGRES_SCHEMA_VERSION,
    initializeMongo,
    initializePostgres,
};
