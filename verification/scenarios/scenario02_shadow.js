const { startBroker, stopBroker } = require('../infra/mqtt_broker');
const { startGateway, stopGateway, startWorker, stopWorker, stopAll } = require('../infra/service_manager');
const { cleanDatabases, resetFactoryDevices, getMongoDb, close } = require('../infra/db_helper');
const ClientSimulator = require('../infra/client_simulator');
const DeviceSimulator = require('../infra/device_simulator');
const { writeReport } = require('../infra/report_helper');

async function run() {
  const startTime = Date.now();
  console.log('\n==================================================');
  console.log(' RUNNING SCENARIO 02: SHADOW ARCHITECTURE ');
  console.log('==================================================');

  let status = 'FAIL';
  let conclusion = '';
  const archValidations = [];
  const issues = [];
  const metrics = { successCount: 0, droppedCount: 0 };

  const clientSim = new ClientSimulator();
  const testMac = '00:1A:2B:3C:4D:5E';
  const testSecret = 'entrance_secret_key_123';
  const deviceSim = new DeviceSimulator(testMac);

  try {
    // 1. Setup
    console.log('[SCENARIO 02] Performing setup...');
    await stopAll();
    await startBroker();
    await cleanDatabases();
    await resetFactoryDevices();
    await startGateway();

    // 2. Register/login and claim device so it is cached in Redis context
    console.log('[SCENARIO 02] Provisioning device...');
    await clientSim.register('test_verify', 'test_verify@example.com', 'xuanlam123');
    await clientSim.login('test_verify@example.com', 'xuanlam123');
    await clientSim.claimDevice(testMac, testSecret, 'Cửa chính phòng khách');

    // 3. Start MQTT Worker
    await startWorker();
    console.log('[SCENARIO 02] Waiting 3s for MQTT Worker to subscribe to topics...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 4. Start Device Simulator and push reported state
    console.log('[SCENARIO 02] Connecting Device Simulator...');
    await deviceSim.start();

    // Push valid state key
    console.log('[SCENARIO 02] Pushing valid state update (lock_state: unlocked)...');
    deviceSim.pushTelemetry({ lock_state: 'unlocked' });
    metrics.successCount++;

    // Push invalid state key (constraint check)
    console.log('[SCENARIO 02] Pushing invalid state update (unknown_key: 1234)...');
    deviceSim.pushTelemetry({ unknown_key: 1234 });

    // Wait 5.0 seconds for batch writer flush to MongoDB
    console.log('[SCENARIO 02] Waiting for Shadow Batch Writer to flush updates to MongoDB...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 5. Verify architectural validation
    const db = await getMongoDb();
    const shadowDoc = await db.collection('devices').findOne({ _id: testMac });

    if (shadowDoc && shadowDoc.state) {
      const reported = shadowDoc.state;

      // Check valid update
      if (reported.lock_state === 'unlocked') {
        archValidations.push(' Shadow reported state lock_state updated to unlocked successfully');
      } else {
        issues.push(` Expected lock_state to be unlocked, but got: ${reported.lock_state}`);
      }

      // Check constraint filter
      if (reported.unknown_key === undefined) {
        archValidations.push(' Shadow constraint filter successfully blocked unknown_key');
      } else {
        issues.push(' Shadow constraint filter failed: unknown_key was written to MongoDB');
      }
    } else {
      issues.push(' Failed to retrieve Shadow Document from MongoDB');
    }

    if (issues.length === 0) {
      status = 'PASS';
      conclusion = 'Shadow State Architecture xác minh thành công. Dữ liệu trạng thái phẳng được cập nhật chính xác và bộ lọc validator đã loại bỏ hoàn toàn các key ngoài luồng.';
    } else {
      conclusion = 'Shadow State Architecture thất bại do lỗi lọc hoặc cập nhật trạng thái.';
    }

  } catch (err) {
    console.error('[SCENARIO 02] Error during execution:', err);
    issues.push(`Runtime error: ${err.message}`);
    conclusion = 'Scenario 02 gặp lỗi runtime.';
  } finally {
    // 6. Cleanup
    console.log('[SCENARIO 02] Cleaning up scenario resources...');
    await deviceSim.stop();
    await stopWorker();
    await stopGateway();
    await stopBroker();
    await cleanDatabases();
    await close();

    const executionTime = Date.now() - startTime;
    writeReport('Shadow State Architecture', {
      executionTime,
      status,
      metrics,
      architecturalValidations: archValidations,
      issues,
      conclusion
    });
    console.log(`[SCENARIO 02] Finished in ${executionTime} ms. Status: ${status}\n`);
  }
}

if (require.main === module) {
  run();
}

module.exports = { run };
