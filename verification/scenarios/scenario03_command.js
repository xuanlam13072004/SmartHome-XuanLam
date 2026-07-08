const { startBroker, stopBroker } = require('../infra/mqtt_broker');
const { startGateway, stopGateway, startWorker, stopWorker, stopAll } = require('../infra/service_manager');
const { cleanDatabases, resetFactoryDevices, pgPool, close } = require('../infra/db_helper');
const ClientSimulator = require('../infra/client_simulator');
const DeviceSimulator = require('../infra/device_simulator');
const { writeReport } = require('../infra/report_helper');

async function run() {
  const startTime = Date.now();
  console.log('\n==================================================');
  console.log(' RUNNING SCENARIO 03: COMMAND LIFECYCLE ');
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
    console.log('[SCENARIO 03] Performing setup...');
    await stopAll();
    await startBroker();
    await cleanDatabases();
    await resetFactoryDevices();
    await startGateway();

    // 2. Provisioning
    console.log('[SCENARIO 03] Provisioning device...');
    await clientSim.register('test_verify', 'test_verify@example.com', 'xuanlam123');
    await clientSim.login('test_verify@example.com', 'xuanlam123');
    await clientSim.claimDevice(testMac, testSecret, 'Cửa chính phòng khách');

    // 3. Start MQTT Worker
    await startWorker();
    console.log('[SCENARIO 03] Waiting 3s for MQTT Worker to subscribe to topics...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 4. Start Device Simulator
    console.log('[SCENARIO 03] Connecting Device Simulator...');
    await deviceSim.start();

    // 5. Send command via Client Simulator
    console.log('[SCENARIO 03] Sending UNLOCK command from Client Simulator...');
    const cmdResponse = await clientSim.sendCommand(testMac, 'UNLOCK', 'main_lock');
    console.log('[SCENARIO 03] Command Response:', cmdResponse);

    if (cmdResponse && cmdResponse.command_id) {
      archValidations.push(' API Gateway successfully accepted the command and returned command_id');
      const commandId = cmdResponse.command_id;

      // Verify command is in PostgreSQL and status is pending/sending/acked
      const dbResult = await pgPool.query('SELECT status FROM device_commands WHERE id = $1', [commandId]);
      if (dbResult.rows.length > 0) {
        archValidations.push(` Command successfully written to PostgreSQL with status: ${dbResult.rows[0].status}`);
      } else {
        issues.push(' Command not found in PostgreSQL device_commands table');
      }

      // Wait 3.0 seconds for Worker processing, MQTT publish, Device Simulator ACK, and status synchronization
      console.log('[SCENARIO 03] Waiting 3s for command delivery, ACK publishing, and synchronization...');
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Verify that device simulator received the command
      if (deviceSim.lastReceivedCommand && deviceSim.lastReceivedCommand.command_id === commandId) {
        archValidations.push(' Device Simulator successfully received the command via MQTT control topic');
      } else {
        issues.push(' Device Simulator did not receive the command');
      }

      // Verify that the command status in PostgreSQL has been updated to 'acked'
      const finalDbResult = await pgPool.query('SELECT status FROM device_commands WHERE id = $1', [commandId]);
      if (finalDbResult.rows.length > 0) {
        const finalStatus = finalDbResult.rows[0].status;
        if (finalStatus === 'acked') {
          archValidations.push(' Command lifecycle successfully completed with status "acked" in PostgreSQL');
          metrics.successCount++;
        } else {
          issues.push(` Expected final command status to be "acked", but got: ${finalStatus}`);
          metrics.failedCount++;
        }
      } else {
        issues.push(' Final command status check failed: command not found in PostgreSQL');
        metrics.failedCount++;
      }
    } else {
      issues.push(' API Gateway command response missing command_id');
      metrics.failedCount++;
    }

    if (issues.length === 0) {
      status = 'PASS';
      conclusion = 'Command Lifecycle Architecture xác minh thành công. Lệnh được API Gateway tiếp nhận, lưu Postgres, chuyển tiếp qua MQTT Worker, thiết bị xử lý và gửi ACK đồng bộ ngược về trạng thái acked trong PostgreSQL.';
    } else {
      conclusion = 'Command Lifecycle Architecture kiểm thử thất bại.';
    }

  } catch (err) {
    console.error('[SCENARIO 03] Error during execution:', err);
    issues.push(`Runtime error: ${err.message}`);
    conclusion = 'Scenario 03 gặp lỗi runtime.';
  } finally {
    // 6. Cleanup
    console.log('[SCENARIO 03] Cleaning up scenario resources...');
    await deviceSim.stop();
    await stopWorker();
    await stopGateway();
    await stopBroker();
    await cleanDatabases();
    await close();

    const executionTime = Date.now() - startTime;
    writeReport('Command Lifecycle', {
      executionTime,
      status,
      metrics,
      architecturalValidations: archValidations,
      issues,
      conclusion
    });
    console.log(`[SCENARIO 03] Finished in ${executionTime} ms. Status: ${status}\n`);
  }
}

if (require.main === module) {
  run();
}

module.exports = { run };
