/**
 * MongoDB Index Builder Script for SmartHome-XuanLam
 * Usage: Run `node database/mongodb/indexes.js`
 */

const { MongoClient } = require('mongodb');
const dotenv = require('dotenv');
const path = require('path');
const dns = require('dns');

// Fix Node.js SRV lookup issues on Windows
try {
    dns.setServers(['8.8.8.8', '8.8.4.4']);
} catch (dnsErr) {
    console.warn('⚠️ Failed to set custom DNS servers:', dnsErr);
}

// Load environment variables from api-gateway/.env
dotenv.config({ path: path.join(__dirname, '../../api-gateway/.env') });

const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017';
const dbName = process.env.MONGO_DB_NAME || 'SmartHomeDB';
const devicesCollectionName = process.env.MONGO_DEVICES_COLLECTION || 'devices';
const telemetryCollectionName = process.env.MONGO_TELEMETRY_COLLECTION || 'telemetry_logs';

async function main() {
    console.log(`Connecting to MongoDB at ${mongoUri.replace(/:([^:@]+)@/, ':****@')}...`);
    const client = new MongoClient(mongoUri);

    try {
        await client.connect();
        console.log('✅ Connected successfully to MongoDB server.');
        const db = client.db(dbName);

        // 1. Indexes for Devices Collection (Device Shadows)
        console.log(`\nBuilding indexes for collection "${devicesCollectionName}" (Device Shadows)...`);
        const devices = db.collection(devicesCollectionName);

        // Index on owner_id for fast user device lists retrieval
        console.log('- Creating index on { owner_id: 1 }...');
        await devices.createIndex({ owner_id: 1 });

        // Index on online status and last_seen for connection health queries
        console.log('- Creating index on { is_online: 1, last_seen: -1 }...');
        await devices.createIndex({ is_online: 1, last_seen: -1 });

        // Index on last_updated for sorting and sync queries
        console.log('- Creating index on { last_updated: -1 }...');
        await devices.createIndex({ last_updated: -1 });


        // 2. Indexes for Telemetry Logs Collection
        console.log(`\nBuilding indexes for collection "${telemetryCollectionName}" (Historical Telemetry)...`);
        const telemetry = db.collection(telemetryCollectionName);

        // Compound index for time-series charts query (e.g. fetch last 24h temp for device X)
        console.log('- Creating compound index on { "metadata.device_id": 1, timestamp: -1 }...');
        await telemetry.createIndex({ "metadata.device_id": 1, timestamp: -1 });

        // Makes unordered batch retries idempotent. The partial filter keeps
        // existing legacy rows (without event_id) valid during rollout.
        console.log('- Creating unique partial index on { event_id: 1 }...');
        await telemetry.createIndex(
            { event_id: 1 },
            { unique: true, partialFilterExpression: { event_id: { $type: 'string' } } }
        );

        // TTL Index: Automatically expire telemetry logs after 30 days to control storage costs
        const expireAfterSeconds = 30 * 24 * 60 * 60; // 30 days
        console.log(`- Creating TTL index on { timestamp: 1 } with expireAfterSeconds = ${expireAfterSeconds}...`);
        await telemetry.createIndex(
            { timestamp: 1 },
            { 
                expireAfterSeconds,
                partialFilterExpression: { "metadata.device_id": { $exists: true } }
            }
        );


        // 3. Indexes for Active Commands Collection (Command Recovery)
        console.log(`\nBuilding indexes for collection "active_commands" (Active Commands Recovery)...`);
        const activeCommands = db.collection('active_commands');
        console.log('- Creating index on { owner_id: 1 }...');
        await activeCommands.createIndex({ owner_id: 1 });

        console.log('\n✅ All MongoDB indexes have been created successfully!');
    } catch (err) {
        console.error('❌ Failed to build indexes:', err.message);
    } finally {
        await client.close();
    }
}

main();
