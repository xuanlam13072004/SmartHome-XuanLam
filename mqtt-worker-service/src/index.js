require('dotenv').config();

const pino = require('pino');

const config = require('./config/env');
const { createRedisClient } = require('./infra/redisClient');
const { createMqttClient } = require('./infra/mqttClient');
const { createMongoClient } = require('./infra/mongoClient');
const { createPostgresPool } = require('./infra/postgresPool');

const logger = pino({
    name: config.SERVICE_NAME,
    level: config.LOG_LEVEL,
});

const state = {
    redis: null,
    mqttClient: null,
    mongoClient: null,
    pgPool: null,
    heartbeatTimer: null,
    shuttingDown: false,
};

async function connectRedis() {
    const redis = createRedisClient({
        redisUrl: config.REDIS_URL,
        logger,
    });

    await redis.ping();
    logger.info('Redis connected');

    state.redis = redis;
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

async function connectPostgres() {
    const pgPool = await createPostgresPool({
        host: config.PG_HOST,
        port: config.PG_PORT,
        database: config.PG_DATABASE,
        user: config.PG_USER,
        password: config.PG_PASSWORD,
        ssl: config.PG_SSL,
        logger,
    });

    state.pgPool = pgPool;
}

function startHeartbeat() {
    state.heartbeatTimer = setInterval(() => {
        const health = {
            redis: Boolean(state.redis),
            mqtt: Boolean(state.mqttClient && state.mqttClient.connected),
            mongo: Boolean(state.mongoClient),
            postgres: Boolean(state.pgPool),
        };

        logger.info({ health }, 'Worker heartbeat');
    }, config.HEARTBEAT_INTERVAL_SECONDS * 1000);
}

async function shutdown(signal) {
    if (state.shuttingDown) return;
    state.shuttingDown = true;

    logger.warn({ signal }, 'Shutting down worker');

    if (state.heartbeatTimer) {
        clearInterval(state.heartbeatTimer);
    }

    const closeTasks = [];

    if (state.mqttClient) {
        closeTasks.push(new Promise((resolve) => {
            state.mqttClient.end(true, {}, resolve);
        }));
    }

    if (state.redis) {
        closeTasks.push(state.redis.quit().catch(() => state.redis.disconnect()));
    }

    if (state.mongoClient) {
        closeTasks.push(state.mongoClient.close());
    }

    if (state.pgPool) {
        closeTasks.push(state.pgPool.end());
    }

    await Promise.allSettled(closeTasks);
    logger.info('Shutdown completed');
    process.exit(0);
}

async function start() {
    logger.info({ env: config.NODE_ENV }, 'Starting mqtt-worker-service');

    await connectRedis();
    await connectMqtt();
    await connectMongo();
    await connectPostgres();

    startHeartbeat();
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
