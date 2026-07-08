const { startBroker, stopBroker } = require('../infra/mqtt_broker');
const { startGateway, stopGateway, startWorker, stopWorker, stopAll } = require('../infra/service_manager');
const { cleanDatabases, resetFactoryDevices, getMongoDb, close } = require('../infra/db_helper');
const ClientSimulator = require('../infra/client_simulator');
const DeviceSimulator = require('../infra/device_simulator');
const { writeReport } = require('../infra/report_helper');

async function run() {
  const startTime = Date.now();
  console.log('\n==================================================');
  console.log(' RUNNING SCENARIO 04: TELEMETRY PROCESSING ');
  console.log('==================================================');

  let status = 'FAIL';
  let conclusion = '';
  const archValidations = [];
  const issues = [];
  const metrics = { successCount: 0, failedCount: 0 };

  const clientSim = new ClientSimulator();
  const testMac = '00:1A:2B:3C:4D:5E';
  const testSecret = 'entrance_secret_key_123';
  const deviceSim = new DeviceSimulator(testMac);

  try {
    // 1. Setup
    console.log('[SCENARIO 04] Performing setup...');
    await stopAll();
    await startBroker();
    await cleanDatabases();
    await resetFactoryDevices();
    await startGateway();

    // 2. Provisioning
    console.log('[SCENARIO 04] Provisioning device...');
    await clientSim.register('test_verify', 'test_verify@example.com', 'xuanlam123');
    await clientSim.login('test_verify@example.com', 'xuanlam123');
    await clientSim.claimDevice(testMac, testSecret, 'Cửa chính phòng khách');

    // 3. Start MQTT Worker
    await startWorker();
    console.log('[SCENARIO 04] Waiting 3s for MQTT Worker to subscribe to topics...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 4. Start Device Simulator
    console.log('[SCENARIO 04] Connecting Device Simulator...');
    await deviceSim.start();

    // 5. Push telemetry metrics
    console.log('[SCENARIO 04] Pushing telemetry packet with metrics: { lock_state: "unlocked" }...');
    deviceSim.pushTelemetry({ lock_state: 'unlocked' });

    // Wait 5.0 seconds for telemetry batch writer to flush to MongoDB
    console.log('[SCENARIO 04] Waiting 5s for Telemetry Batch Writer to flush to MongoDB...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 6. Verify telemetry logs in MongoDB
    const db = await getMongoDb();
    const telemetryCol = db.collection('telemetry_logs');
    const logDoc = await telemetryCol.findOne({ 'metadata.device_id': testMac });

    if (logDoc) {
      console.log('[SCENARIO 04] Found Telemetry Log in MongoDB:', logDoc);
      archValidations.push(' Telemetry Log document successfully created in MongoDB "telemetry_logs" collection');

      // Verify correct metadata
      if (logDoc.metadata.device_id === testMac) {
        archValidations.push(' Telemetry Log contains correct device_id');
      } else {
        issues.push(` Expected device_id: ${testMac}, but got: ${logDoc.metadata.device_id}`);
      }

      // Verify correct metrics
      if (logDoc.lock_state === 'unlocked') {
        archValidations.push(' Telemetry Log contains correct metrics (lock_state: unlocked)');
        metrics.successCount++;
      } else {
        issues.push(` Expected lock_state: unlocked, but got: ${logDoc.lock_state}`);
        metrics.failedCount++;
      }
    } else {
      issues.push(' Failed to find Telemetry Log document in MongoDB "telemetry_logs" collection');
      metrics.failedCount++;
    }

    if (issues.length === 0) {
      status = 'PASS';
      conclusion = 'Telemetry Processing & Storage xác minh thành công. Dữ liệu telemetry từ thiết bị được nhận, validate và lưu trữ dưới dạng time-series log chính xác trong MongoDB.';
    } else {
      conclusion = 'Telemetry Processing & Storage kiểm thử thất bại.';
    }

  } catch (err) {
    console.error('[SCENARIO 04] Error during execution:', err);
    issues.push(`Runtime error: ${err.message}`);
    conclusion = 'Scenario 04 gặp lỗi runtime.';
  } finally {
    // 7. Cleanup
    console.log('[SCENARIO 04] Cleaning up scenario resources...');
    await deviceSim.stop();
    await stopWorker();
    await stopGateway();
    await stopBroker();
    await cleanDatabases();
    await close();

    const executionTime = Date.now() - startTime;
    writeReport('Telemetry Processing', {
      executionTime,
      status,
      metrics,
      architecturalValidations: archValidations,
      issues,
      conclusion
    });
    console.log(`[SCENARIO 04] Finished in ${executionTime} ms. Status: ${status}\n`);
  }
}

if (require.main === module) {
  run();
}

module.exports = { run };
