const Redis = require('ioredis');
const { startBroker, stopBroker } = require('../infra/mqtt_broker');
const { startGateway, stopGateway, startWorker, stopWorker, startRealtime, stopRealtime, stopAll } = require('../infra/service_manager');
const { cleanDatabases, resetFactoryDevices, pgPool, close } = require('../infra/db_helper');
const ClientSimulator = require('../infra/client_simulator');
const DeviceSimulator = require('../infra/device_simulator');
const { writeReport } = require('../infra/report_helper');

async function run() {
  const startTime = Date.now();
  console.log('\n==================================================');
  console.log(' RUNNING SCENARIO 06: AUTOMATION ENGINE ');
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
  let redisSub = null;
  let triggeredCommandId = null;

  try {
    // 1. Setup
    console.log('[SCENARIO 06] Performing setup...');
    await stopAll();
    await startBroker();
    await cleanDatabases();
    await resetFactoryDevices();
    await startGateway();
    await startRealtime();

    // 2. Provisioning
    console.log('[SCENARIO 06] Provisioning device...');
    await clientSim.register('test_verify', 'test_verify@example.com', 'xuanlam123');
    await clientSim.login('test_verify@example.com', 'xuanlam123');
    await clientSim.claimDevice(testMac, testSecret, 'Cửa chính phòng khách');

    // 3. Connect Redis for Automation Rule Engine simulation
    console.log('[SCENARIO 06] Launching mock Automation Rule Engine (listening to Redis Pub/Sub)...');
    redisSub = new Redis('redis://localhost:6379');
    await redisSub.subscribe('device.telemetry');

    redisSub.on('message', async (channel, message) => {
      try {
        const event = JSON.parse(message);
        console.log('[AUTOMATION ENGINE] Received telemetry event:', event);

        // Check trigger condition: lock_state is unlocked
        if (event.mac === testMac && event.payload && event.payload.state && event.payload.state.lock_state === 'unlocked') {
          console.log('[AUTOMATION ENGINE] Trigger matched: lock_state is unlocked. Executing action: Turn on alarm_siren...');
          
          archValidations.push(' Automation Rule Engine successfully matched trigger condition (lock_state: unlocked)');
          
          // Execute action: call API Gateway to turn on alarm_siren
          const actionResponse = await clientSim.sendCommand(testMac, 'SET_SWITCH', 'alarm_siren', { value: true });
          console.log('[AUTOMATION ENGINE] Action execution response:', actionResponse);
          if (actionResponse && actionResponse.command_id) {
            triggeredCommandId = actionResponse.command_id;
            archValidations.push(' Automation Action command successfully created on API Gateway');
          }
        }
      } catch (err) {
        console.error('[AUTOMATION ENGINE] Error processing telemetry event:', err);
      }
    });

    // 4. Start MQTT Worker
    await startWorker();
    console.log('[SCENARIO 06] Waiting 3s for MQTT Worker to subscribe to topics...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 5. Connect Device Simulator
    console.log('[SCENARIO 06] Connecting Device Simulator...');
    await deviceSim.start();

    // 6. Push triggering telemetry
    console.log('[SCENARIO 06] Device pushes trigger telemetry (lock_state: unlocked)...');
    deviceSim.pushTelemetry({ lock_state: 'unlocked' });

    // Wait 5 seconds for E2E flow to complete: Telemetry -> Rule Engine -> Command -> Device ACK -> DB
    console.log('[SCENARIO 06] Waiting 5s for automation loop execution...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 7. Verification
    if (triggeredCommandId) {
      // Verify that device simulator received the command
      if (deviceSim.lastReceivedCommand && deviceSim.lastReceivedCommand.command_id === triggeredCommandId) {
        archValidations.push(' Device Simulator successfully received the triggered action command (SET_SWITCH alarm_siren)');
      } else {
        issues.push(' Device Simulator did not receive the triggered action command');
      }

      // Verify that the command status is acked in PostgreSQL
      const dbResult = await pgPool.query('SELECT status FROM device_commands WHERE id = $1', [triggeredCommandId]);
      if (dbResult.rows.length > 0) {
        const finalStatus = dbResult.rows[0].status;
        if (finalStatus === 'acked') {
          archValidations.push(' Automation action command completed with status "acked" in PostgreSQL');
          metrics.successCount++;
        } else {
          issues.push(` Expected triggered command status to be "acked", but got: ${finalStatus}`);
          metrics.failedCount++;
        }
      } else {
        issues.push(' Triggered command not found in PostgreSQL');
        metrics.failedCount++;
      }
    } else {
      issues.push(' Automation Rule Engine trigger failed to execute action (no command was sent)');
      metrics.failedCount++;
    }

    if (issues.length === 0) {
      status = 'PASS';
      conclusion = 'Automation Engine Architecture được xác minh thành công. Thiết bị báo telemetry, Rule Engine phát hiện điều kiện kích hoạt, phát lệnh điều khiển ngược xuống thiết bị và thiết bị thực thi trả về ACK đầy đủ E2E.';
    } else {
      conclusion = 'Automation Engine Architecture kiểm thử thất bại.';
    }

  } catch (err) {
    console.error('[SCENARIO 06] Error during execution:', err);
    issues.push(`Runtime error: ${err.message}`);
    conclusion = 'Scenario 06 gặp lỗi runtime.';
  } finally {
    // 8. Cleanup
    console.log('[SCENARIO 06] Cleaning up scenario resources...');
    if (redisSub) {
      redisSub.disconnect();
    }
    await deviceSim.stop();
    await stopWorker();
    await stopGateway();
    await stopRealtime();
    await stopBroker();
    await cleanDatabases();
    await close();

    const executionTime = Date.now() - startTime;
    writeReport('Automation Engine', {
      executionTime,
      status,
      metrics,
      architecturalValidations: archValidations,
      issues,
      conclusion
    });
    console.log(`[SCENARIO 06] Finished in ${executionTime} ms. Status: ${status}\n`);
  }
}

if (require.main === module) {
  run();
}

module.exports = { run };
