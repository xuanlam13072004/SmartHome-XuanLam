const { startBroker, stopBroker } = require('../infra/mqtt_broker');
const { startGateway, stopGateway, startWorker, stopWorker, startRealtime, stopRealtime, stopAll } = require('../infra/service_manager');
const { cleanDatabases, resetFactoryDevices, close } = require('../infra/db_helper');
const ClientSimulator = require('../infra/client_simulator');
const DeviceSimulator = require('../infra/device_simulator');
const { writeReport } = require('../infra/report_helper');

async function run() {
  const startTime = Date.now();
  console.log('\n==================================================');
  console.log(' RUNNING SCENARIO 05: REAL-TIME STREAMING & WS ');
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
    console.log('[SCENARIO 05] Performing setup...');
    await stopAll();
    await startBroker();
    await cleanDatabases();
    await resetFactoryDevices();
    await startGateway();
    await startRealtime();

    // 2. Provisioning
    console.log('[SCENARIO 05] Provisioning device...');
    await clientSim.register('test_verify', 'test_verify@example.com', 'xuanlam123');
    await clientSim.login('test_verify@example.com', 'xuanlam123');
    await clientSim.claimDevice(testMac, testSecret, 'Cửa chính phòng khách');

    // 3. Connect client WebSocket simulator
    console.log('[SCENARIO 05] Connecting Client WebSocket Simulator...');
    await clientSim.connectWS();

    // 4. Start MQTT Worker
    await startWorker();
    console.log('[SCENARIO 05] Waiting 3s for MQTT Worker to subscribe to topics...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 5. Start Device Simulator and push telemetry
    console.log('[SCENARIO 05] Connecting Device Simulator...');
    await deviceSim.start();
    console.log('[SCENARIO 05] Pushing telemetry packet with metrics: { lock_state: "unlocked" }...');
    deviceSim.pushTelemetry({ lock_state: 'unlocked' });

    // 6. Wait for WebSocket event with a 6-second timeout
    console.log('[SCENARIO 05] Waiting for WebSocket real-time event to arrive...');
    let eventReceived = null;
    const checkStartTime = Date.now();
    while (Date.now() - checkStartTime < 6000) {
      const found = clientSim.receivedEvents.find(e => e.event === 'telemetry' && e.mac === testMac);
      if (found) {
        eventReceived = found;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    if (eventReceived) {
      console.log('[SCENARIO 05] Received WebSocket Event:', eventReceived);
      archValidations.push(' Client Simulator successfully received "telemetry" event via WebSocket');

      const payload = eventReceived.payload;
      if (payload && payload.state && payload.state.lock_state === 'unlocked') {
        archValidations.push(' Real-time event payload contains updated state metrics (lock_state: unlocked)');
        metrics.successCount++;
      } else {
        issues.push(` Event payload state incorrect: ${JSON.stringify(payload)}`);
        metrics.failedCount++;
      }
    } else {
      issues.push(' Timeout: WebSocket "telemetry" event did not arrive');
      metrics.failedCount++;
    }

    if (issues.length === 0) {
      status = 'PASS';
      conclusion = 'Real-time Event Streaming & WebSockets xác minh thành công. Dữ liệu thay đổi trạng thái từ MQTT Worker được publish lên Redis Pub/Sub, chuyển tiếp và phân phối chính xác qua WebSockets cho khách hàng đăng ký.';
    } else {
      conclusion = 'Real-time Event Streaming & WebSockets kiểm thử thất bại.';
    }

  } catch (err) {
    console.error('[SCENARIO 05] Error during execution:', err);
    issues.push(`Runtime error: ${err.message}`);
    conclusion = 'Scenario 05 gặp lỗi runtime.';
  } finally {
    // 7. Cleanup
    console.log('[SCENARIO 05] Cleaning up scenario resources...');
    clientSim.disconnectWS();
    await deviceSim.stop();
    await stopWorker();
    await stopGateway();
    await stopRealtime();
    await stopBroker();
    await cleanDatabases();
    await close();

    const executionTime = Date.now() - startTime;
    writeReport('Real-time Streaming', {
      executionTime,
      status,
      metrics,
      architecturalValidations: archValidations,
      issues,
      conclusion
    });
    console.log(`[SCENARIO 05] Finished in ${executionTime} ms. Status: ${status}\n`);
  }
}

if (require.main === module) {
  run();
}

module.exports = { run };
