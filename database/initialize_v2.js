'use strict';

const { Client } = require('pg');
const { MongoClient } = require('mongodb');

const { applyMongoCollectionsV2 } = require('./mongodb/v2/apply-collections');
const { seedCatalogV2 } = require('./mongodb/v2/seed-catalog');
const { LATEST_SCHEMA_VERSION, applyPostgresSchema } = require('./postgres/migrate');

function assertInitializationGate() {
    if (process.env.ALLOW_V2_DATABASE_INITIALIZATION !== 'true') {
        throw new Error('ALLOW_V2_DATABASE_INITIALIZATION=true is required.');
    }
}

const POSTGRES_SCHEMA_VERSION = LATEST_SCHEMA_VERSION;
const REQUIRED_POSTGRES_TABLES = [
    'accounts',
    'user_sessions',
    'account_preferences',
    'rooms',
    'scenes',
    'scene_steps',
    'scene_runs',
    'scene_run_steps',
    'scene_schedules',
    'automations',
    'account_notifications',
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
        const fresh = existingTables.length === 0;
        if (!fresh && !existingTables.includes('schema_migrations')) {
            throw new Error(
                `PostgreSQL contains an incompatible schema: ${existingTables.join(', ')}. `
                + 'Clear the configured PostgreSQL data directory before starting the new architecture.',
            );
        }

        // Baseline on a fresh database, then any pending upgrade steps; data is kept.
        const { newlyApplied } = await applyPostgresSchema(client, { fresh });

        const tables = await client.query(
            `SELECT table_name FROM information_schema.tables
              WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
        );
        const present = new Set(tables.rows.map(row => row.table_name));
        const missing = REQUIRED_POSTGRES_TABLES.filter(table => !present.has(table));
        if (missing.length > 0) {
            throw new Error(
                `PostgreSQL schema is incomplete or incompatible. Missing: ${missing.join(', ')}. `
                + 'Clear the configured PostgreSQL data directory and initialize again.',
            );
        }
        process.stdout.write(
            `PostgreSQL schema ${POSTGRES_SCHEMA_VERSION}: ${fresh ? 'installed' : 'kept existing data'}`
            + `${newlyApplied.length > 0 ? `, applied ${newlyApplied.join(', ')}` : ''}.\n`,
        );
        return { initialized: fresh, schemaVersion: POSTGRES_SCHEMA_VERSION, newlyApplied };
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
