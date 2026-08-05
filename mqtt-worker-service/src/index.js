require('dotenv').config();
const pino = require('pino');

const config = require('./config/env');
const { createRedisClient } = require('./infra/redisClient');
const { createMqttClient } = require('./infra/mqttClient');
const { createMongoClient } = require('./infra/mongoClient');
const { RuntimeCatalog } = require('../../shared/catalog-v2');
const { startOperationConsumer } = require('./workers/operationConsumer');
const { startCredentialConsumer } = require('./workers/credentialConsumer');
const { startTelemetrySubscriber } = require('./workers/telemetrySubscriber');
const { startPresenceWorker } = require('./workers/presenceWorker');
const { startTopologySubscriber } = require('./workers/topologySubscriber');
const { startHealthMonitor } = require('./monitoring/healthMonitor');

const { TelemetryBatchWriter } = require('./services/telemetryBatchWriter');
const { ShadowBatchWriter } = require('./services/shadowBatchWriter');
const { initTelemetryProcessor } = require('./services/telemetryProcessor');
const { TelemetrySanitizer } = require('./services/telemetrySanitizer');
const { RealtimePublisher } = require('./services/realtimePublisher');
const http = require('http');
const { getPrometheusMetrics } = require('./monitoring/metrics');

const logger = pino({
    name: config.SERVICE_NAME,
    level: config.LOG_LEVEL,
});

const state = {
    redis: null,
    blockingRedis: null,
    credentialRedis: null,
    mqttClient: null,
    mongoClient: null,
    heartbeatTimer: null,
    healthTimer: null,
    shuttingDown: false,
    operationConsumerTask: null,
    credentialConsumerTask: null,
    telemetrySubscriberTask: null,
    presenceWorkerTask: null,
    presenceWorkerCleanup: null,
    topologySubscriberCleanup: null,
    telemetryWriter: null,
    shadowWriter: null,
    telemetryProcessorCleanup: null,
    metricsServer: null,
};

async function connectRedis() {
    const redis = createRedisClient({
        redisUrl: config.REDIS_URL,
        logger,
    });

    await redis.ping();
    logger.info('Redis connected');

    state.redis = redis;
    state.blockingRedis = redis.duplicate();
    await state.blockingRedis.ping();
    state.credentialRedis = redis.duplicate();
    await state.credentialRedis.ping();
    logger.info('Redis blocking connection initialized');
}

async function connectMqtt() {
    const mqttClient = createMqttClient({
        brokerUrl: config.MQTT_BROKER_URL,
        clientId: config.MQTT_CLIENT_ID,
        username: config.MQTT_USERNAME,
        password: config.MQTT_PASSWORD,
        logger,
    });

    await new Promise((resolve, reject) => {
        mqttClient.once('connect', () => resolve());
        mqttClient.once('error', (err) => reject(err));
    });

    state.mqttClient = mqttClient;
}

async function connectMongo() {
    const mongoClient = await createMongoClient({
        mongoUri: config.MONGO_URI,
        dbName: config.MONGO_DB_NAME,
        logger,
    });

    state.mongoClient = mongoClient;
}

function startHeartbeat() {
    state.heartbeatTimer = setInterval(() => {
        const health = {
            redis: Boolean(state.redis),
            mqtt: Boolean(state.mqttClient && state.mqttClient.connected),
            mongo: Boolean(state.mongoClient),
        };

        logger.info({ health }, 'Worker heartbeat');
    }, config.HEARTBEAT_INTERVAL_SECONDS * 1000);
}

async function shutdown(signal) {
    if (state.shuttingDown) return;
    state.shuttingDown = true;

    logger.warn({ signal }, 'Shutting down worker gracefully...');

    // Đặt hard timeout 30 giây để buộc tắt máy nếu bị kẹt
    const forceExitTimeout = setTimeout(() => {
        logger.error('Graceful shutdown timed out (30s exceeded). Forcing exit.');
        process.exit(1);
    }, 30000);

    if (state.heartbeatTimer) {
        clearInterval(state.heartbeatTimer);
    }

    if (state.healthTimer) {
        clearInterval(state.healthTimer);
    }

    if (state.metricsServer) {
        try {
            await new Promise(resolve => state.metricsServer.close(resolve));
            logger.info('Prometheus metrics server stopped.');
        } catch (err) {
            logger.error({ err }, 'Error stopping metrics server');
        }
    }

    try {
        if (state.presenceWorkerCleanup) {
            state.presenceWorkerCleanup();
        }
    } catch (err) {
        logger.error({ err }, 'Error stopping presence worker');
    }

    try {
        if (state.topologySubscriberCleanup) {
            await state.topologySubscriberCleanup();
        }
    } catch (err) {
        logger.error({ err }, 'Error stopping topology subscriber');
    }

    try {
        if (state.telemetryProcessorCleanup) {
            await state.telemetryProcessorCleanup();
        }
    } catch (err) {
        logger.error({ err }, 'Error cleaning up telemetry processor');
    }

    // Shutdown Batch Writers ghi nốt dữ liệu còn lại
    const shutdownPromises = [];
    if (state.telemetryWriter) {
        shutdownPromises.push(state.telemetryWriter.shutdown());
    }
    if (state.shadowWriter) {
        shutdownPromises.push(state.shadowWriter.shutdown());
    }
    await Promise.allSettled(shutdownPromises);

    const closeTasks = [];

    if (state.mqttClient) {
        closeTasks.push(new Promise((resolve) => {
            state.mqttClient.end(true, {}, resolve);
        }));
    }

    if (state.redis) {
        closeTasks.push(state.redis.quit().catch(() => state.redis.disconnect()));
    }

    if (state.blockingRedis) {
        closeTasks.push(state.blockingRedis.quit().catch(() => state.blockingRedis.disconnect()));
    }
    if (state.credentialRedis) {
        closeTasks.push(state.credentialRedis.quit().catch(() => state.credentialRedis.disconnect()));
    }

    if (state.mongoClient) {
        closeTasks.push(state.mongoClient.close());
    }

    await Promise.allSettled(closeTasks);
    
    clearTimeout(forceExitTimeout);
    logger.info('Graceful shutdown completed successfully.');
    process.exit(0);
}

async function start() {
    logger.info({ env: config.NODE_ENV }, 'Starting mqtt-worker-service');

    // Startup Validation: Fail Early if database connections fail
    try {
        await connectRedis();
        await connectMqtt();
        await connectMongo();
    } catch (err) {
        logger.fatal({ err }, 'Worker startup connection failed. Exiting.');
        process.exit(1);
    }

    const catalog = new RuntimeCatalog({ log: logger });
    await catalog.start();
    state.catalog = catalog;

    // Khởi tạo các Batch Writers & Chức năng Pipeline
    state.telemetryWriter = new TelemetryBatchWriter(state.mongoClient, state.mqttClient, config, logger);
    state.shadowWriter = new ShadowBatchWriter(state.mongoClient, config, logger);
    state.telemetrySanitizer = new TelemetrySanitizer(logger);
    state.realtimePublisher = new RealtimePublisher(state.redis, logger);

    startHeartbeat();

    // Start workers (non-blocking, run in background)
    const clients = {
        redis: state.redis,
        mqttClient: state.mqttClient,
        mongoClient: state.mongoClient,
        catalog: state.catalog,
        telemetryWriter: state.telemetryWriter,
        shadowWriter: state.shadowWriter,
        telemetrySanitizer: state.telemetrySanitizer,
        realtimePublisher: state.realtimePublisher,
    };

    // Khởi tạo Telemetry Processor (Cache L1 & Invalidation Subscriber)
    state.telemetryProcessorCleanup = initTelemetryProcessor(clients, config, logger);
    state.topologySubscriberCleanup = await startTopologySubscriber(
        clients,
        config,
        logger
    );

    // Khởi chạy Prometheus Metrics server (port 9100 mặc định hoặc từ METRICS_PORT)
    const metricsPort = process.env.METRICS_PORT || 9100;
    state.metricsServer = http.createServer((req, res) => {
        if (req.url === '/metrics') {
            res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
            res.end(getPrometheusMetrics(state.telemetryWriter, state.shadowWriter));
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
        }
    });
    state.metricsServer.listen(metricsPort, '0.0.0.0', () => {
        logger.info({ port: metricsPort }, 'Prometheus metrics server listening');
    });

    state.operationConsumerTask = startOperationConsumer({ ...clients, redis: state.blockingRedis }, config, logger).catch((err) => {
        logger.fatal({ err }, 'Operation consumer fatal error');
        process.exit(1);
    });
    state.credentialConsumerTask = startCredentialConsumer(
        { ...clients, redis: state.credentialRedis }, config, logger,
    ).catch((err) => {
        logger.fatal({ err }, 'Credential consumer fatal error');
        process.exit(1);
    });

    state.telemetrySubscriberTask = startTelemetrySubscriber(state.mqttClient, clients, config, logger).catch((err) => {
        logger.fatal({ err }, 'Telemetry subscriber fatal error');
        process.exit(1);
    });

    state.presenceWorkerTask = startPresenceWorker(clients, config, logger)
        .then((cleanup) => {
            state.presenceWorkerCleanup = cleanup;
        })
        .catch((err) => {
            logger.fatal({ err }, 'Presence worker fatal error');
            process.exit(1);
        });

    state.healthTimer = startHealthMonitor(clients, config, logger);

    logger.info('Worker is ready');
}

process.on('SIGINT', () => {
    shutdown('SIGINT');
});

process.on('SIGTERM', () => {
    shutdown('SIGTERM');
});

start().catch((err) => {
    logger.fatal({ err }, 'Worker failed to start');
    process.exit(1);
});
