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
    if (process.env.V2_EXPECT_EMPTY_DATABASES !== 'true') {
        throw new Error('V2_EXPECT_EMPTY_DATABASES=true is required.');
    }
}

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
        if (result.rows.length > 0) {
            throw new Error(`PostgreSQL target is not empty: ${result.rows.map(row => row.table_name).sort().join(', ')}`);
        }

        const schema = fs.readFileSync(path.join(__dirname, 'postgres/schema_v2.sql'), 'utf8');
        await client.query(schema);
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
        if (existing.length > 0) {
            throw new Error(`MongoDB target is not empty: ${existing.map(item => item.name).sort().join(', ')}`);
        }
        await applyMongoCollectionsV2(db);
        await seedCatalogV2(db);
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
    process.stdout.write('Database V2 initialization completed.\n');
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`${error.stack || error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    assertInitializationGate,
    initializeMongo,
    initializePostgres,
};
