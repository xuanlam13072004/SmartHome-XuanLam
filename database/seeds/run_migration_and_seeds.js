const fs = require('fs');
const path = require('path');
const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const { Client } = require('pg');
const { MongoClient } = require('mongodb');
require('dotenv').config({ path: path.join(__dirname, '../../api-gateway/.env') });

async function runPostgresMigration() {
    console.log('--- STARTING POSTGRES MIGRATION ---');
    const pgConfig = {
        host: process.env.PG_HOST || 'localhost',
        port: parseInt(process.env.PG_PORT || '5432'),
        database: process.env.PG_DATABASE || 'smarthome',
        user: process.env.PG_USER || 'postgres',
        password: process.env.PG_PASSWORD || 'postgres',
    };

    const client = new Client(pgConfig);
    await client.connect();

    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS public.schema_migrations (
                version integer PRIMARY KEY,
                name text NOT NULL,
                applied_at timestamp with time zone NOT NULL DEFAULT now()
            )
        `);

        console.log('Checking database schema state...');
        const requiredTables = ['accounts', 'device_metadata', 'device_commands', 'factory_devices', 'user_sessions'];
        const tableResult = await client.query(
            `SELECT table_name FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
            [requiredTables]
        );
        const existingTables = new Set(tableResult.rows.map(row => row.table_name));
        const accountsExists = existingTables.has('accounts');

        if (!accountsExists) {
            if (existingTables.size > 0) {
                throw new Error(`Partial database schema detected: ${[...existingTables].join(', ')}`);
            }
            console.log('Database is empty. Running schema.sql...');
            const schemaPath = path.join(__dirname, '../postgres/schema.sql');
            const schemaSql = fs.readFileSync(schemaPath, 'utf8');
            await client.query(schemaSql);
            console.log('schema.sql applied successfully.');
        } else {
            const missingTables = requiredTables.filter(table => !existingTables.has(table));
            if (missingTables.length > 0) {
                throw new Error(`Partial database schema detected. Missing: ${missingTables.join(', ')}`);
            }
            console.log('Database already initialized. Running migrations...');
        }

        const migrations = [
            { version: 2, file: 'migration_v2.sql' },
            { version: 3, file: 'migration_v3.sql' },
            { version: 4, file: 'migration_v4.sql' },
        ];

        for (const migration of migrations) {
            const applied = await client.query(
                'SELECT 1 FROM public.schema_migrations WHERE version = $1',
                [migration.version]
            );
            if (applied.rows.length > 0) continue;

            const migrationPath = path.join(__dirname, '../postgres', migration.file);
            if (!fs.existsSync(migrationPath)) {
                throw new Error(`Migration file is missing: ${migrationPath}`);
            }

            console.log(`Applying migration v${migration.version}: ${migrationPath}`);
            await client.query('BEGIN');
            try {
                await client.query(fs.readFileSync(migrationPath, 'utf8'));
                await client.query(
                    'INSERT INTO public.schema_migrations (version, name) VALUES ($1, $2)',
                    [migration.version, migration.file]
                );
                await client.query('COMMIT');
                console.log(`${migration.file} applied successfully.`);
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            }
        }

        console.log('PostgreSQL migration completed successfully.');
    } catch (err) {
        console.error('PostgreSQL migration failed:', err);
        throw err; // Stop process if Postgres fails
    } finally {
        await client.end();
    }
}

async function runMongoSeeding() {
    console.log('\n--- STARTING MONGODB SEEDING ---');
    const mongoUri = process.env.MONGO_URI;
    const dbName = process.env.MONGO_DB_NAME || 'SmartHomeDB';

    if (!mongoUri) {
        throw new Error('MONGO_URI environment variable is missing.');
    }

    console.log(`Connecting to MongoDB...`);
    const mongoClient = new MongoClient(mongoUri);
    await mongoClient.connect();

    try {
        const db = mongoClient.db(dbName);

        // 1. Seed Capabilities
        const capabilitiesPath = path.join(__dirname, 'capabilities.json');
        console.log(`Reading capabilities seed from: ${capabilitiesPath}`);
        const capabilitiesData = JSON.parse(fs.readFileSync(capabilitiesPath, 'utf8'));

        const capCol = db.collection('capabilities');
        console.log(`Upserting ${capabilitiesData.length} capabilities...`);
        if (capabilitiesData.length > 0) {
            await capCol.bulkWrite(capabilitiesData.map(item => ({
                replaceOne: { filter: { _id: item._id }, replacement: item, upsert: true }
            })), { ordered: false });
            await capCol.deleteMany({ _id: { $nin: capabilitiesData.map(item => item._id) } });
        }
        console.log('MongoDB capabilities seeded successfully.');

        // 2. Seed Products
        const productsPath = path.join(__dirname, 'products.json');
        console.log(`Reading products seed from: ${productsPath}`);
        const productsData = JSON.parse(fs.readFileSync(productsPath, 'utf8'));

        const prodCol = db.collection('products');
        console.log(`Upserting ${productsData.length} products...`);
        if (productsData.length > 0) {
            await prodCol.bulkWrite(productsData.map(item => ({
                replaceOne: { filter: { _id: item._id }, replacement: item, upsert: true }
            })), { ordered: false });
            await prodCol.deleteMany({ _id: { $nin: productsData.map(item => item._id) } });
        }
        console.log('MongoDB products seeded successfully.');

        // Telemetry retry idempotency must be present in every deployment, not
        // only when the standalone index builder is run manually.
        await db.collection(process.env.MONGO_TELEMETRY_COLLECTION || 'telemetry_logs').createIndex(
            { event_id: 1 },
            { unique: true, partialFilterExpression: { event_id: { $type: 'string' } } }
        );
        console.log('MongoDB telemetry event_id unique index ensured.');

        // 3. Migrate existing MongoDB devices (Clean Break: role -> product_id)
        const devicesCol = db.collection('devices');
        console.log('Migrating existing device shadow records (role -> product_id)...');

        // Migrate 'smart_plug' -> 'prod_smart_plug'
        let res = await devicesCol.updateMany(
            { role: 'smart_plug' },
            { $set: { product_id: 'prod_smart_plug' }, $unset: { role: 1 } }
        );
        console.log(`Updated ${res.modifiedCount} devices from role:smart_plug to product_id:prod_smart_plug`);

        // Migrate 'rgb_light' -> 'prod_rgb_light'
        res = await devicesCol.updateMany(
            { role: 'rgb_light' },
            { $set: { product_id: 'prod_rgb_light' }, $unset: { role: 1 } }
        );
        console.log(`Updated ${res.modifiedCount} devices from role:rgb_light to product_id:prod_rgb_light`);

        // Migrate 'switch_2_gang' -> 'prod_switch_2_gang'
        res = await devicesCol.updateMany(
            { role: 'switch_2_gang' },
            { $set: { product_id: 'prod_switch_2_gang' }, $unset: { role: 1 } }
        );
        console.log(`Updated ${res.modifiedCount} devices from role:switch_2_gang to product_id:prod_switch_2_gang`);

        console.log('MongoDB device shadow migration completed.');
    } catch (err) {
        console.error('MongoDB seeding failed:', err);
        throw err;
    } finally {
        await mongoClient.close();
    }
}

async function main() {
    try {
        await runPostgresMigration();
        await runMongoSeeding();
        console.log('\n====================================');
        console.log(' DATABASE MIGRATION & SEEDING DONE! ');
        console.log('====================================');
    } catch (err) {
        console.error('\nDatabase upgrade failed:', err);
        process.exit(1);
    }
}

main();
