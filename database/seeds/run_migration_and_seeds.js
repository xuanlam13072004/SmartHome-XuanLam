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
        const sqlPath = path.join(__dirname, '../postgres/migration_v3.sql');
        console.log(`Reading SQL migration from: ${sqlPath}`);
        const sqlContent = fs.readFileSync(sqlPath, 'utf8');

        console.log('Executing PostgreSQL migration...');
        await client.query(sqlContent);
        console.log('PostgreSQL migration completed successfully.');
    } catch (err) {
        console.error('PostgreSQL migration failed:', err);
        throw err;
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
        console.log('Clearing old capabilities...');
        await capCol.deleteMany({});
        console.log(`Inserting ${capabilitiesData.length} capabilities...`);
        await capCol.insertMany(capabilitiesData);
        console.log('MongoDB capabilities seeded successfully.');

        // 2. Seed Products
        const productsPath = path.join(__dirname, 'products.json');
        console.log(`Reading products seed from: ${productsPath}`);
        const productsData = JSON.parse(fs.readFileSync(productsPath, 'utf8'));

        const prodCol = db.collection('products');
        console.log('Clearing old products...');
        await prodCol.deleteMany({});
        console.log(`Inserting ${productsData.length} products...`);
        await prodCol.insertMany(productsData);
        console.log('MongoDB products seeded successfully.');

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
        try {
            await runPostgresMigration();
        } catch (pgErr) {
            console.warn('PostgreSQL migration failed or already applied. Continuing to MongoDB seeding...', pgErr.message);
        }
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
