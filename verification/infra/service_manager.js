const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const rootDir = path.resolve(__dirname, '../..');
const logsDir = path.join(__dirname, '../reports/logs');

if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

let gatewayProc = null;
let workerProc = null;
let realtimeProc = null;

function logToFile(serviceName, data) {
  const logPath = path.join(logsDir, `${serviceName}.log`);
  fs.appendFileSync(logPath, data.toString());
}

function waitForReady(proc, serviceName, readyPattern, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve();
    };
    const timer = setTimeout(() => {
      finish(new Error(`${serviceName} did not become ready within ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (data) => {
      if (readyPattern.test(data.toString())) finish();
    });
    proc.once('error', err => finish(new Error(`${serviceName} failed to spawn: ${err.message}`)));
    proc.once('close', code => {
      if (!settled) finish(new Error(`${serviceName} exited before readiness with code ${code}`));
    });
  });
}

function killProcess(proc) {
  if (!proc) return;
  try {
    if (process.platform === 'win32') {
      const { execSync } = require('child_process');
      execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
    } else {
      proc.kill();
    }
  } catch (e) {}
}

function stopGateway() {
  return new Promise((resolve) => {
    if (gatewayProc) {
      console.log('[INFRA] Stopping API Gateway...');
      killProcess(gatewayProc);
      gatewayProc = null;
    }
    setTimeout(resolve, 1500);
  });
}

async function startGateway() {
    console.log('[INFRA] Starting API Gateway...');
    gatewayProc = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: path.join(rootDir, 'api-gateway'),
      shell: true,
      env: { ...process.env, PORT: '3000', NODE_PATH: path.join(rootDir, 'api-gateway/node_modules') }
    });

    gatewayProc.stdout.on('data', (data) => {
      logToFile('api-gateway', data);
    });

    gatewayProc.stderr.on('data', (data) => {
      logToFile('api-gateway', data);
    });

    gatewayProc.on('close', (code) => {
      console.log(`[INFRA] API Gateway stopped with code ${code}`);
    });

    await waitForReady(gatewayProc, 'API Gateway', /listening on/i, 15000);
    console.log('[INFRA] API Gateway is ready');
}

async function startWorker() {
    console.log('[INFRA] Starting MQTT Worker...');
    workerProc = spawn('node', ['src/index.js'], {
      cwd: path.join(rootDir, 'mqtt-worker-service'),
      shell: true,
      env: { ...process.env, NODE_PATH: path.join(rootDir, 'mqtt-worker-service/node_modules') }
    });

    workerProc.stdout.on('data', (data) => {
      logToFile('mqtt-worker-service', data);
    });

    workerProc.stderr.on('data', (data) => {
      logToFile('mqtt-worker-service', data);
    });

    workerProc.on('close', (code) => {
      console.log(`[INFRA] MQTT Worker stopped with code ${code}`);
    });

    await waitForReady(workerProc, 'MQTT Worker', /Starting mqtt-worker-service|Redis connected|listening/i, 15000);
    console.log('[INFRA] MQTT Worker is ready');
}

function stopWorker() {
  return new Promise((resolve) => {
    if (workerProc) {
      console.log('[INFRA] Stopping MQTT Worker...');
      killProcess(workerProc);
      workerProc = null;
    }
    setTimeout(resolve, 1500);
  });
}

async function startRealtime() {
    console.log('[INFRA] Starting Realtime WebSocket Service...');
    realtimeProc = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: path.join(rootDir, 'real-time-service'),
      shell: true,
      env: { ...process.env, PORT: '3001', NODE_PATH: path.join(rootDir, 'real-time-service/node_modules') }
    });

    realtimeProc.stdout.on('data', (data) => {
      logToFile('real-time-service', data);
    });

    realtimeProc.stderr.on('data', (data) => {
      logToFile('real-time-service', data);
    });

    realtimeProc.on('close', (code) => {
      console.log(`[INFRA] Realtime Service stopped with code ${code}`);
    });

    await waitForReady(realtimeProc, 'Realtime Service', /WebSocket server running/i, 15000);
    console.log('[INFRA] Realtime Service is ready');
}

function stopRealtime() {
  return new Promise((resolve) => {
    if (realtimeProc) {
      console.log('[INFRA] Stopping Realtime Service...');
      killProcess(realtimeProc);
      realtimeProc = null;
    }
    setTimeout(resolve, 1500);
  });
}

async function stopAll() {
  await stopGateway();
  await stopWorker();
  await stopRealtime();
  await new Promise(resolve => setTimeout(resolve, 1000));
}

module.exports = {
  startGateway,
  stopGateway,
  startWorker,
  stopWorker,
  startRealtime,
  stopRealtime,
  stopAll
};
