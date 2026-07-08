const { Pool } = require('pg');
const { MongoClient } = require('mongodb');
const Redis = require('ioredis');
const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);
require('dotenv').config({ path: 'c:/SmartHome-XuanLam/api-gateway/.env' });

const pgPool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432', 10),
  database: process.env.PG_DATABASE || 'smarthome',
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || 'postgres'
});

async function cleanAll() {
  console.log('🧹 [CLEANUP] Starting Verification Cleanup...');

  // 1. Clean PostgreSQL test records
  try {
    console.log('🧹 [CLEANUP] Cleaning PostgreSQL tables...');
    await pgPool.query('DELETE FROM device_commands');
    await pgPool.query('DELETE FROM device_metadata');
    await pgPool.query('DELETE FROM user_sessions');
    await pgPool.query('DELETE FROM accounts');
    
    // Delete only test MACs from factory_devices
    const testMacs = [
      '00:1A:2B:3C:4D:5E',
      '00:1A:2B:3C:4D:5F',
      '00:1A:2B:3C:4D:60',
      '00:1A:2B:3C:4D:61'
    ];
    await pgPool.query('DELETE FROM factory_devices WHERE mac = ANY($1)', [testMacs]);
    console.log('✅ [CLEANUP] PostgreSQL test records cleaned.');
  } catch (err) {
    console.error('❌ [CLEANUP] Error cleaning PostgreSQL:', err);
  }

  // 2. Clean MongoDB collections (keeping capabilities and products)
  let mongoClient = null;
  try {
    console.log('🧹 [CLEANUP] Cleaning MongoDB collections...');
    mongoClient = new MongoClient(process.env.MONGO_URI);
    await mongoClient.connect();
    const db = mongoClient.db(process.env.MONGO_DB_NAME || 'SmartHomeDB');

    // Clean devices (shadows), telemetry_logs, active_commands
    const devicesDeleted = await db.collection('devices').deleteMany({});
    const telemetryDeleted = await db.collection('telemetry_logs').deleteMany({});
    const commandsDeleted = await db.collection('active_commands').deleteMany({});

    console.log(`✅ [CLEANUP] MongoDB shadow devices deleted: ${devicesDeleted.deletedCount}`);
    console.log(`✅ [CLEANUP] MongoDB telemetry logs deleted: ${telemetryDeleted.deletedCount}`);
    console.log(`✅ [CLEANUP] MongoDB active commands deleted: ${commandsDeleted.deletedCount}`);
  } catch (err) {
    console.error('❌ [CLEANUP] Error cleaning MongoDB:', err);
  } finally {
    if (mongoClient) {
      await mongoClient.close();
    }
  }

  // 3. Flush Redis DB
  let redis = null;
  try {
    console.log('🧹 [CLEANUP] Flushing Redis database...');
    redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    const response = await redis.flushall();
    console.log(`✅ [CLEANUP] Redis flushall response: ${response}`);
  } catch (err) {
    console.error('❌ [CLEANUP] Error flushing Redis:', err);
  } finally {
    if (redis) {
      redis.disconnect();
    }
  }

  await pgPool.end();
  console.log('🎉 [CLEANUP] Database cleanup process completed successfully.');
}

if (require.main === module) {
  cleanAll();
}

module.exports = { cleanAll };
