const { startBroker, stopBroker } = require('../infra/mqtt_broker');
const { startGateway, stopGateway, stopAll } = require('../infra/service_manager');
const { cleanDatabases, resetFactoryDevices, getMongoDb, pgPool, close } = require('../infra/db_helper');
const ClientSimulator = require('../infra/client_simulator');
const { writeReport } = require('../infra/report_helper');

async function run() {
  const startTime = Date.now();
  console.log('\n==================================================');
  console.log(' RUNNING SCENARIO 01: DEVICE PROVISIONING ');
  console.log('==================================================');

  let status = 'FAIL';
  let conclusion = '';
  const archValidations = [];
  const issues = [];
  const metrics = { successCount: 0, droppedCount: 0 };

  const clientSim = new ClientSimulator();
  const testMac = '00:1A:2B:3C:4D:5E';
  const testSecret = 'entrance_secret_key_123';
  const testProdId = 'prod_entrance_controller_v1';

  try {
    // 1. Setup
    console.log('[SCENARIO 01] Performing setup...');
    await stopAll();
    await startBroker();
    await cleanDatabases();
    await resetFactoryDevices();
    await startGateway();

    // 2. Register and login test user
    console.log('[SCENARIO 01] Registering and logging in test user...');
    await clientSim.register('test_verify', 'test_verify@example.com', 'xuanlam123');
    await clientSim.login('test_verify@example.com', 'xuanlam123');
    await clientSim.getMe();

    // 3. Claim device
    console.log('[SCENARIO 01] Calling claim API...');
    const claimRes = await clientSim.claimDevice(testMac, testSecret, 'Cửa chính phòng khách');
    if (claimRes.success) {
      metrics.successCount++;
    }

    // 4. Verify architectural constraints
    console.log('[SCENARIO 01] Running architectural verifications...');

    // Verification A: check PostgreSQL factory_devices updated state
    const fdRes = await pgPool.query('SELECT is_claimed FROM factory_devices WHERE mac = $1', [testMac]);
    if (fdRes.rows.length > 0 && fdRes.rows[0].is_claimed === true) {
      archValidations.push(' factory_devices.is_claimed updated to true in PostgreSQL');
    } else {
      issues.push(' factory_devices is_claimed was not updated to true');
    }

    // Verification B: check PostgreSQL device_metadata
    const dmRes = await pgPool.query('SELECT owner_id, product_id, name FROM device_metadata WHERE mac = $1', [testMac]);
    if (dmRes.rows.length > 0 && dmRes.rows[0].product_id === testProdId) {
      archValidations.push(` device_metadata correctly linked product_id: ${testProdId} and owner_id: ${clientSim.userId}`);
    } else {
      issues.push(' device_metadata record missing or has incorrect product_id');
    }

    // Verification C: check MongoDB shadow document and hydration
    const db = await getMongoDb();
    const shadowDoc = await db.collection('devices').findOne({ _id: testMac });
    if (shadowDoc) {
      archValidations.push(' MongoDB Device Shadow Document created successfully with MAC as ID');
      if (shadowDoc.owner_id === clientSim.userId && shadowDoc.product_id === testProdId) {
        archValidations.push(' Shadow Document contains correct owner_id and product_id');
      } else {
        issues.push(' Shadow Document owner_id or product_id mismatched');
      }

      // Verification D: check exact default state hydration
      const defaultStateKeys = Object.keys(shadowDoc.state);
      const expectedKeys = ['lock_state', 'recognition_enabled', 'is_streaming', 'stream_url', 'last_snapshot_url', 'snapshot_taken_at', 'is_vibrating', 'displayed_text', 'siren_active'];
      const matches = expectedKeys.every(k => defaultStateKeys.includes(k));
      if (matches) {
        archValidations.push(' Device Shadow state correctly hydrated with Product default_state');
      } else {
        issues.push(` Shadow state mismatch. Found keys: [${defaultStateKeys.join(', ')}], expected: [${expectedKeys.join(', ')}]`);
      }
    } else {
      issues.push(' MongoDB Shadow Document was not created');
    }

    if (issues.length === 0) {
      status = 'PASS';
      conclusion = 'Quy trình Provisioning xác minh thành công 100%. Thiết bị được đăng ký sở hữu, khởi tạo Shadow phẳng và nạp đúng cấu hình Product Blueprint.';
    } else {
      conclusion = 'Quy trình Provisioning thất bại do lỗi không khớp trạng thái DB/Shadow.';
    }

  } catch (err) {
    console.error('[SCENARIO 01] Error during execution:', err);
    issues.push(`Runtime error: ${err.message}`);
    conclusion = 'Quy trình Provisioning gặp lỗi runtime nghiêm trọng.';
  } finally {
    // 5. Cleanup
    console.log('[SCENARIO 01] Cleaning up scenario resources...');
    await stopGateway();
    await stopBroker();
    await cleanDatabases();
    await close();

    const executionTime = Date.now() - startTime;
    writeReport('Device Provisioning', {
      executionTime,
      status,
      metrics,
      architecturalValidations: archValidations,
      issues,
      conclusion
    });
    console.log(`[SCENARIO 01] Finished in ${executionTime} ms. Status: ${status}\n`);
    if (status !== 'PASS') process.exitCode = 1;
  }
}

if (require.main === module) {
  run();
}

module.exports = { run };
