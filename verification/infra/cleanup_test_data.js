const { Pool } = require('pg');
const { MongoClient } = require('mongodb');
const Redis = require('ioredis');
const dns = require('dns');
const path = require('path');
const devicesFixture = require('../fixtures/devices.json');
dns.setServers(['8.8.8.8', '8.8.4.4']);
require('dotenv').config({ path: path.resolve(__dirname, '../../api-gateway/.env') });

const pgPool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432', 10),
  database: process.env.PG_DATABASE || 'smarthome',
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || 'postgres'
});

async function cleanAll() {
  if (process.env.NODE_ENV !== 'test' || process.env.ALLOW_DESTRUCTIVE_TEST_CLEANUP !== 'true') {
    throw new Error(
      'Refusing cleanup: set NODE_ENV=test and ALLOW_DESTRUCTIVE_TEST_CLEANUP=true explicitly.'
    );
  }

  console.log('🧹 [CLEANUP] Starting Verification Cleanup...');
  const testMacs = devicesFixture.map((device) => device.mac);
  const cleanupErrors = [];

  // 1. Clean PostgreSQL test records
  try {
    console.log('🧹 [CLEANUP] Cleaning PostgreSQL tables...');
    await pgPool.query('DELETE FROM device_commands WHERE mac = ANY($1)', [testMacs]);
    await pgPool.query('DELETE FROM device_metadata WHERE mac = ANY($1)', [testMacs]);
    await pgPool.query("DELETE FROM accounts WHERE email = 'test_verify@example.com'");

    // Delete only test MACs from factory_devices
    await pgPool.query('DELETE FROM factory_devices WHERE mac = ANY($1)', [testMacs]);
    console.log('✅ [CLEANUP] PostgreSQL test records cleaned.');
  } catch (err) {
    cleanupErrors.push(err);
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
    const devicesDeleted = await db.collection('devices').deleteMany({ _id: { $in: testMacs } });
    const telemetryDeleted = await db.collection('telemetry_logs').deleteMany({ 'metadata.device_id': { $in: testMacs } });
    const commandsDeleted = await db.collection('active_commands').deleteMany({ mac: { $in: testMacs } });

    console.log(`✅ [CLEANUP] MongoDB shadow devices deleted: ${devicesDeleted.deletedCount}`);
    console.log(`✅ [CLEANUP] MongoDB telemetry logs deleted: ${telemetryDeleted.deletedCount}`);
    console.log(`✅ [CLEANUP] MongoDB active commands deleted: ${commandsDeleted.deletedCount}`);
  } catch (err) {
    cleanupErrors.push(err);
    console.error('❌ [CLEANUP] Error cleaning MongoDB:', err);
  } finally {
    if (mongoClient) {
      await mongoClient.close();
    }
  }

  // 3. Redis cleanup is allowed only for a dedicated test database.
  let redis = null;
  try {
    console.log('🧹 [CLEANUP] Cleaning Redis test database...');
    if (process.env.ALLOW_TEST_REDIS_FLUSHDB === 'true') {
      redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
      const response = await redis.flushdb();
      console.log(`✅ [CLEANUP] Redis flushdb response: ${response}`);
    } else {
      console.log('ℹ️ [CLEANUP] Redis flush skipped. Set ALLOW_TEST_REDIS_FLUSHDB=true for a dedicated test DB.');
    }
  } catch (err) {
    cleanupErrors.push(err);
    console.error('❌ [CLEANUP] Error flushing Redis:', err);
  } finally {
    if (redis) {
      redis.disconnect();
    }
  }

  await pgPool.end();
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'One or more test cleanup operations failed');
  }
  console.log('🎉 [CLEANUP] Database cleanup process completed successfully.');
}

if (require.main === module) {
  cleanAll().catch((err) => {
    console.error('❌ [CLEANUP] Cleanup aborted:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { cleanAll };
