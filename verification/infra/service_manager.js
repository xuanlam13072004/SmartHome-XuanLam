const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const rootDir = 'c:/SmartHome-XuanLam';
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

function startGateway() {
  return new Promise((resolve) => {
    console.log('[INFRA] Starting API Gateway...');
    // We run tsx directly or npx tsx
    gatewayProc = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: path.join(rootDir, 'api-gateway'),
      shell: true,
      env: { ...process.env, NODE_PATH: path.join(rootDir, 'api-gateway/node_modules') }
    });

    gatewayProc.stdout.on('data', (data) => {
      logToFile('api-gateway', data);
      if (data.toString().includes('listening on')) {
        console.log('[INFRA] API Gateway is ready');
        resolve();
      }
    });

    gatewayProc.stderr.on('data', (data) => {
      logToFile('api-gateway', data);
    });

    gatewayProc.on('close', (code) => {
      console.log(`[INFRA] API Gateway stopped with code ${code}`);
    });

    // Fallback resolve after 4 seconds
    setTimeout(resolve, 4000);
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

function killPort(port) {
  try {
    const { execSync } = require('child_process');
    if (process.platform === 'win32') {
      const output = execSync(`netstat -aon`).toString();
      const lines = output.split('\n');
      for (const line of lines) {
        if (line.includes(`:${port}`) && line.includes('LISTENING')) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (pid && pid !== '0') {
            execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
            console.log(`[INFRA] Killed process ${pid} listening on port ${port}`);
          }
        }
      }
    }
  } catch (e) {}
}

function stopGateway() {
  return new Promise((resolve) => {
    if (gatewayProc) {
      console.log('[INFRA] Stopping API Gateway...');
      killProcess(gatewayProc);
      gatewayProc = null;
    } else {
      killPort(3000);
    }
    setTimeout(resolve, 1500);
  });
}

function startGateway() {
  return new Promise((resolve) => {
    console.log('[INFRA] Starting API Gateway...');
    gatewayProc = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: path.join(rootDir, 'api-gateway'),
      shell: true,
      env: { ...process.env, PORT: '3000', NODE_PATH: path.join(rootDir, 'api-gateway/node_modules') }
    });

    gatewayProc.on('error', (err) => {
      console.error('[INFRA] API Gateway failed to spawn:', err);
    });

    gatewayProc.stdout.on('data', (data) => {
      logToFile('api-gateway', data);
      if (data.toString().includes('listening on')) {
        console.log('[INFRA] API Gateway is ready');
        resolve();
      }
    });

    gatewayProc.stderr.on('data', (data) => {
      logToFile('api-gateway', data);
    });

    gatewayProc.on('close', (code) => {
      console.log(`[INFRA] API Gateway stopped with code ${code}`);
    });

    setTimeout(resolve, 15000);
  });
}

function startWorker() {
  return new Promise((resolve) => {
    console.log('[INFRA] Starting MQTT Worker...');
    workerProc = spawn('node', ['src/index.js'], {
      cwd: path.join(rootDir, 'mqtt-worker-service'),
      shell: true,
      env: { ...process.env, NODE_PATH: path.join(rootDir, 'mqtt-worker-service/node_modules') }
    });

    workerProc.on('error', (err) => {
      console.error('[INFRA] MQTT Worker failed to spawn:', err);
    });

    workerProc.stdout.on('data', (data) => {
      logToFile('mqtt-worker-service', data);
      if (data.toString().includes('Starting mqtt-worker-service') || data.toString().includes('Redis connected') || data.toString().includes('listening')) {
        resolve();
      }
    });

    workerProc.stderr.on('data', (data) => {
      logToFile('mqtt-worker-service', data);
    });

    workerProc.on('close', (code) => {
      console.log(`[INFRA] MQTT Worker stopped with code ${code}`);
    });

    setTimeout(resolve, 3000);
  });
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

function startRealtime() {
  return new Promise((resolve) => {
    console.log('[INFRA] Starting Realtime WebSocket Service...');
    realtimeProc = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: path.join(rootDir, 'real-time-service'),
      shell: true,
      env: { ...process.env, PORT: '3001', NODE_PATH: path.join(rootDir, 'real-time-service/node_modules') }
    });

    realtimeProc.on('error', (err) => {
      console.error('[INFRA] Realtime Service failed to spawn:', err);
    });

    realtimeProc.stdout.on('data', (data) => {
      logToFile('real-time-service', data);
      if (data.toString().includes('WebSocket server running')) {
        console.log('[INFRA] Realtime Service is ready');
        resolve();
      }
    });

    realtimeProc.stderr.on('data', (data) => {
      logToFile('real-time-service', data);
    });

    realtimeProc.on('close', (code) => {
      console.log(`[INFRA] Realtime Service stopped with code ${code}`);
    });

    setTimeout(resolve, 4000);
  });
}

function stopRealtime() {
  return new Promise((resolve) => {
    if (realtimeProc) {
      console.log('[INFRA] Stopping Realtime Service...');
      killProcess(realtimeProc);
      realtimeProc = null;
    } else {
      killPort(3001);
    }
    setTimeout(resolve, 1500);
  });
}

async function stopAll() {
  await stopGateway();
  await stopWorker();
  await stopRealtime();
  killPort(3000);
  killPort(3001);
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
