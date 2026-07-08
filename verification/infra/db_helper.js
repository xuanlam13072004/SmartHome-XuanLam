const { Pool } = require('pg');
const { MongoClient } = require('mongodb');
const argon2 = require('argon2');
const path = require('path');
const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);
require('dotenv').config({ path: 'c:/SmartHome-XuanLam/api-gateway/.env' });

const devicesFixture = require('../fixtures/devices.json');

const pgPool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432', 10),
  database: process.env.PG_DATABASE || 'smarthome',
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || 'postgres'
});

let mongoClient = null;

async function getMongoDb() {
  if (!mongoClient) {
    mongoClient = new MongoClient(process.env.MONGO_URI);
    await mongoClient.connect();
  }
  return mongoClient.db(process.env.MONGO_DB_NAME || 'SmartHomeDB');
}

async function cleanDatabases() {
  console.log('[INFRA DB] Cleaning shadow states and commands...');
  const macs = devicesFixture.map(d => d.mac);
  
  // 1. Clean Postgres metadata and command logs for test MACs
  if (macs.length > 0) {
    const placeholders = macs.map((_, i) => `$${i + 1}`).join(',');
    await pgPool.query(`DELETE FROM device_commands WHERE mac IN (${placeholders})`, macs);
    await pgPool.query(`DELETE FROM device_metadata WHERE mac IN (${placeholders})`, macs);
  }

  // 2. Clean MongoDB shadow collection
  const db = await getMongoDb();
  const shadowCol = db.collection(process.env.MONGO_DEVICES_COLLECTION || 'devices');
  if (macs.length > 0) {
    await shadowCol.deleteMany({ _id: { $in: macs } });
  }

  // 3. Clean test account
  await pgPool.query("DELETE FROM accounts WHERE email = 'test_verify@example.com'");
  console.log('[INFRA DB] Cleanup completed successfully');
}

async function resetFactoryDevices() {
  console.log('[INFRA DB] Resetting factory_devices in PostgreSQL...');
  
  // Clear any existing test devices from factory_devices
  const macs = devicesFixture.map(d => d.mac);
  if (macs.length > 0) {
    const placeholders = macs.map((_, i) => `$${i + 1}`).join(',');
    await pgPool.query(`DELETE FROM factory_devices WHERE mac IN (${placeholders})`, macs);
  }

  // Insert mock hardware configurations
  for (const dev of devicesFixture) {
    const hashedKey = await argon2.hash(dev.secret_key);
    await pgPool.query(
      `
      INSERT INTO factory_devices (mac, secret_key, product_id, is_claimed, created_at)
      VALUES ($1, $2, $3, false, NOW())
      `,
      [dev.mac, hashedKey, dev.product_id]
    );
    console.log(`[INFRA DB] Seeded factory device ${dev.mac} (${dev.product_id})`);
  }
}

async function close() {
  await pgPool.end();
  if (mongoClient) {
    await mongoClient.close();
    mongoClient = null;
  }
}

module.exports = {
  pgPool,
  getMongoDb,
  cleanDatabases,
  resetFactoryDevices,
  close
};
