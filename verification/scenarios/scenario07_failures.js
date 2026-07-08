const { startBroker, stopBroker } = require('../infra/mqtt_broker');
const { startGateway, stopGateway, startWorker, stopWorker, stopAll } = require('../infra/service_manager');
const { cleanDatabases, resetFactoryDevices, getMongoDb, close } = require('../infra/db_helper');
const ClientSimulator = require('../infra/client_simulator');
const DeviceSimulator = require('../infra/device_simulator');
const { writeReport } = require('../infra/report_helper');

async function run() {
  const startTime = Date.now();
  console.log('\n==================================================');
  console.log(' RUNNING SCENARIO 07: FAILURE RECOVERY ');
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
    console.log('[SCENARIO 07] Performing setup...');
    await stopAll();
    await startBroker();
    await cleanDatabases();
    await resetFactoryDevices();
    await startGateway();

    // 2. Provisioning
    console.log('[SCENARIO 07] Provisioning device...');
    await clientSim.register('test_verify', 'test_verify@example.com', 'xuanlam123');
    await clientSim.login('test_verify@example.com', 'xuanlam123');
    await clientSim.claimDevice(testMac, testSecret, 'Cửa chính phòng khách');

    // 3. Start MQTT Worker
    await startWorker();
    console.log('[SCENARIO 07] Waiting 3s for MQTT Worker to subscribe to topics...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 4. Start Device Simulator
    console.log('[SCENARIO 07] Connecting Device Simulator...');
    await deviceSim.start();

    // 5. Simulate MQTT Broker Failure
    console.log('[SCENARIO 07] --- SIMULATING MQTT BROKER SHUTDOWN ---');
    await stopBroker();
    console.log('[SCENARIO 07] MQTT Broker stopped. Waiting 3s...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    console.log('[SCENARIO 07] --- SIMULATING MQTT BROKER RESTART ---');
    await startBroker();
    console.log('[SCENARIO 07] MQTT Broker restarted. Waiting 5s for auto-reconnection...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 6. Push telemetry after broker restart
    console.log('[SCENARIO 07] Pushing telemetry packet with metrics: { lock_state: "locked" } after broker recovery...');
    deviceSim.pushTelemetry({ lock_state: 'locked' });

    // Wait 5 seconds for worker processing & flush
    console.log('[SCENARIO 07] Waiting 5s for Telemetry Batch Writer to flush to MongoDB...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 7. Verify shadow document in MongoDB
    const db = await getMongoDb();
    const shadowDoc = await db.collection('devices').findOne({ _id: testMac });

    if (shadowDoc && shadowDoc.state) {
      const reported = shadowDoc.state;
      if (reported.lock_state === 'locked') {
        archValidations.push(' System successfully self-healed and processed telemetry after MQTT Broker restart');
        metrics.successCount++;
      } else {
        issues.push(` Expected lock_state to be "locked" after recovery, but got: ${reported.lock_state}`);
        metrics.failedCount++;
      }
    } else {
      issues.push(' Failed to find Shadow Document in MongoDB after broker recovery');
      metrics.failedCount++;
    }

    if (issues.length === 0) {
      status = 'PASS';
      conclusion = 'Failure Recovery test passed. Dịch vụ MQTT Worker và Device Simulator tự phục hồi kết nối thành công sau khi Broker bị khởi động lại và truyền tin bình thường.';
    } else {
      conclusion = 'Failure Recovery test failed.';
    }

  } catch (err) {
    console.error('[SCENARIO 07] Error during execution:', err);
    issues.push(`Runtime error: ${err.message}`);
    conclusion = 'Scenario 07 gặp lỗi runtime.';
  } finally {
    // 8. Cleanup
    console.log('[SCENARIO 07] Cleaning up scenario resources...');
    await deviceSim.stop();
    await stopWorker();
    await stopGateway();
    await stopBroker();
    await cleanDatabases();
    await close();

    const executionTime = Date.now() - startTime;
    writeReport('Failure Recovery', {
      executionTime,
      status,
      metrics,
      architecturalValidations: archValidations,
      issues,
      conclusion
    });
    console.log(`[SCENARIO 07] Finished in ${executionTime} ms. Status: ${status}\n`);
  }
}

if (require.main === module) {
  run();
}

module.exports = { run };
