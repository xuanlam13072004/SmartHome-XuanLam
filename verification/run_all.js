const path = require('path');
const fs = require('fs');

function percentile(values, percentileValue) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

async function runAll() {
  console.log('==================================================');
  console.log('     SMARTHOME-XUANLAM INTEGRATION TEST RUNNER     ');
  console.log('==================================================');

  const scenarios = [
    { name: 'scenario01_provisioning.js', desc: 'Device Provisioning Flow' },
    { name: 'scenario02_shadow.js', desc: 'Shadow State Architecture' },
    { name: 'scenario03_command.js', desc: 'Command Lifecycle & ACK' },
    { name: 'scenario04_telemetry.js', desc: 'Telemetry Ingestion & Storage' },
    { name: 'scenario05_realtime.js', desc: 'Real-time WebSocket Push' },
    { name: 'scenario06_automation.js', desc: 'Automation Rule Engine' },
    { name: 'scenario07_failures.js', desc: 'Failure Recovery & Self-healing' },
    { name: 'scenario08_chaos.js', desc: 'Chaos & Resilience Testing' }
  ];

  const results = [];
  let passedCount = 0;

  for (const scen of scenarios) {
    const filePath = path.join(__dirname, 'scenarios', scen.name);
    console.log(`\n[RUNNER] Starting ${scen.desc} (${scen.name})...`);

    const start = Date.now();
    let status = 'FAIL';
    let error = null;

    try {
      if (!fs.existsSync(filePath)) {
        throw new Error(`Scenario file not found: ${scen.name}`);
      }
      
      const { fork } = require('child_process');
      const child = fork(filePath, [], {
        env: { 
          ...process.env, 
          NODE_PATH: `${path.join(__dirname, '../api-gateway/node_modules')};${path.join(__dirname, 'node_modules')}` 
        }
      });

      await new Promise((resolve, reject) => {
        child.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Scenario exited with code ${code}`));
          }
        });
        child.on('error', (err) => {
          reject(err);
        });
      });

      status = 'PASS';
      passedCount++;
    } catch (err) {
      console.error(`[RUNNER] Scenario ${scen.name} failed with error:`, err);
      error = err.message;
    }

    const duration = Date.now() - start;
    results.push({
      name: scen.name,
      desc: scen.desc,
      status,
      duration,
      error
    });
  }

  console.log('\n==================================================');
  console.log('               TEST RUNNER SUMMARY                ');
  console.log('==================================================');
  console.log(`Total Scenarios: ${scenarios.length}`);
  console.log(`Passed: ${passedCount} / ${scenarios.length}`);
  console.log(`Failed: ${scenarios.length - passedCount}`);
  console.log('--------------------------------------------------');

  for (const res of results) {
    const statusSymbol = res.status === 'PASS' ? '✅' : '❌';
    console.log(`${statusSymbol} [${res.status}] ${res.desc} (${res.name}) - ${res.duration}ms`);
    if (res.error) {
      console.log(`   └─ Error: ${res.error}`);
    }
  }
  console.log('==================================================');

  // Compile a master report in Markdown format
  const reportsDir = path.join(__dirname, 'reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const masterReportPath = path.join(reportsDir, 'master_verification_report.md');
  const durations = results.map((result) => result.duration);
  const allPassed = passedCount === scenarios.length;
  let masterContent = `# Master Verification Report: SmartHome-XuanLam Runtime Integration Suite

* **Time of Run**: ${new Date().toLocaleString('vi-VN')}
* **Overall Status**: ${allPassed ? 'PASS' : 'FAIL'}
* **Success Rate**: ${((passedCount / scenarios.length) * 100).toFixed(0)}% (${passedCount}/${scenarios.length} passed)

## 1. Executive Summary
This report summarizes the E2E verification of the SmartHome-XuanLam capability architecture.

## 2. Test Execution Details

| # | Test Scenario | Description | Status | Duration |
|---|---|---|---|---|
${results.map((res, i) => `| ${i + 1} | \`${res.name}\` | ${res.desc} | **${res.status}** | ${res.duration} ms |`).join('\n')}

## 3. Scenario Duration Summary
These values are calculated from the measured end-to-end duration of each scenario:
- **P50 Duration**: ${percentile(durations, 50)} ms
- **P95 Duration**: ${percentile(durations, 95)} ms
- **P99 Duration**: ${percentile(durations, 99)} ms

## 4. Conclusion
${allPassed
  ? 'All specified scenarios completed successfully.'
  : `${scenarios.length - passedCount} scenario(s) failed. The architecture must not be considered verified until the failures above are resolved.`}
`;

  fs.writeFileSync(masterReportPath, masterContent, 'utf8');
  console.log(`[RUNNER] Master verification report generated at: ${masterReportPath}`);

  if (passedCount !== scenarios.length) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

if (require.main === module) {
  runAll();
}

module.exports = { runAll };
