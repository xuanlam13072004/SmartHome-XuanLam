const { startBroker, stopBroker } = require('../infra/mqtt_broker');
const { startGateway, stopGateway, startWorker, stopWorker, stopAll } = require('../infra/service_manager');
const { cleanDatabases, resetFactoryDevices, getMongoDb, close } = require('../infra/db_helper');
const ClientSimulator = require('../infra/client_simulator');
const DeviceSimulator = require('../infra/device_simulator');
const { writeReport } = require('../infra/report_helper');

async function run() {
  const startTime = Date.now();
  console.log('\n==================================================');
  console.log(' RUNNING SCENARIO 08: CHAOS TESTING ');
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
    console.log('[SCENARIO 08] Performing setup...');
    await stopAll();
    await startBroker();
    await cleanDatabases();
    await resetFactoryDevices();
    await startGateway();

    // 2. Provisioning
    console.log('[SCENARIO 08] Provisioning device...');
    await clientSim.register('test_verify', 'test_verify@example.com', 'xuanlam123');
    await clientSim.login('test_verify@example.com', 'xuanlam123');
    await clientSim.claimDevice(testMac, testSecret, 'Cửa chính phòng khách');

    // 3. Start MQTT Worker
    await startWorker();
    console.log('[SCENARIO 08] Waiting 3s for MQTT Worker to subscribe to topics...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 4. Start Device Simulator
    console.log('[SCENARIO 08] Connecting Device Simulator...');
    await deviceSim.start();

    // 5. Inject Chaos: Stop Worker and API Gateway simultaneously
    console.log('[SCENARIO 08] --- INJECTING CHAOS: STOPPING GATEWAY AND WORKER ---');
    await Promise.all([
      stopWorker(),
      stopGateway()
    ]);
    console.log('[SCENARIO 08] Gateway and Worker stopped. Waiting 3s...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Try to send telemetry during service outage (should buffer on broker or fail gracefully)
    console.log('[SCENARIO 08] Device publishes telemetry during service outage...');
    deviceSim.pushTelemetry({ lock_state: 'locked' });

    // 6. Restore Services
    console.log('[SCENARIO 08] --- RESTORING SERVICES ---');
    await Promise.all([
      startGateway(),
      startWorker()
    ]);
    console.log('[SCENARIO 08] Services restored. Waiting 5s for recovery and reconnects...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Push new telemetry post-recovery to verify flow is fully functional
    console.log('[SCENARIO 08] Device publishes new telemetry (lock_state: unlocked) after recovery...');
    deviceSim.pushTelemetry({ lock_state: 'unlocked' });

    // Wait 5 seconds for telemetry batch writer to flush to MongoDB
    console.log('[SCENARIO 08] Waiting 5s for Telemetry Batch Writer to flush to MongoDB...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 7. Verify shadow document in MongoDB
    const db = await getMongoDb();
    const shadowDoc = await db.collection('devices').findOne({ _id: testMac });

    if (shadowDoc && shadowDoc.state) {
      const reported = shadowDoc.state;
      if (reported.lock_state === 'unlocked') {
        archValidations.push(' System successfully survived chaos injection and processed new telemetry post-recovery');
        metrics.successCount++;
      } else {
        issues.push(` Expected lock_state to be "unlocked" after chaos recovery, but got: ${reported.lock_state}`);
        metrics.failedCount++;
      }
    } else {
      issues.push(' Failed to find Shadow Document in MongoDB after chaos recovery');
      metrics.failedCount++;
    }

    if (issues.length === 0) {
      status = 'PASS';
      conclusion = 'Chaos Test passed. Dịch vụ tự khôi phục hoàn chỉnh và tiếp tục tiêu thụ tin nhắn chuẩn xác sau đợt gián đoạn dịch vụ Gateway/Worker đồng thời.';
    } else {
      conclusion = 'Chaos Test thất bại.';
    }

  } catch (err) {
    console.error('[SCENARIO 08] Error during execution:', err);
    issues.push(`Runtime error: ${err.message}`);
    conclusion = 'Scenario 08 gặp lỗi runtime.';
  } finally {
    // 8. Cleanup
    console.log('[SCENARIO 08] Cleaning up scenario resources...');
    await deviceSim.stop();
    await stopWorker();
    await stopGateway();
    await stopBroker();
    await cleanDatabases();
    await close();

    const executionTime = Date.now() - startTime;
    writeReport('Chaos Testing', {
      executionTime,
      status,
      metrics,
      architecturalValidations: archValidations,
      issues,
      conclusion
    });
    console.log(`[SCENARIO 08] Finished in ${executionTime} ms. Status: ${status}\n`);
  }
}

if (require.main === module) {
  run();
}

module.exports = { run };
