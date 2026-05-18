/**
 * Tác dụng của file này:
 * - Health check thực tế: ping Redis/Mongo/PG
 * - Metrics tối thiểu: stream pending, stream length, event loop lag
 * - Log định kỳ để dễ quan sát production
 */

function startHealthMonitor(clients, config, logger) {
    const interval = config.HEALTHCHECK_INTERVAL_MS;

    let lastTick = process.hrtime.bigint();

    const timer = setInterval(async () => {
        const now = process.hrtime.bigint();
        const expectedNs = BigInt(interval) * 1000000n;
        const lagNs = now - lastTick - expectedNs;
        lastTick = now;

        const health = {
            redis: false,
            mongo: false,
            postgres: false,
            mqtt: Boolean(clients.mqttClient && clients.mqttClient.connected),
        };

        const metrics = {
            event_loop_lag_ms: Number(lagNs > 0n ? lagNs / 1000000n : 0n),
            redis_stream_pending: null,
            redis_stream_length: null,
        };

        // Redis ping + stream metrics
        try {
            await clients.redis.ping();
            health.redis = true;

            const streamKey = config.REDIS_COMMAND_STREAM;
            const groupName = config.REDIS_COMMAND_GROUP;

            const pending = await clients.redis.call('XPENDING', streamKey, groupName);
            // XPENDING returns [count, minId, maxId, [consumer, count]...]
            metrics.redis_stream_pending = Array.isArray(pending) ? Number(pending[0]) : null;

            const length = await clients.redis.call('XLEN', streamKey);
            metrics.redis_stream_length = Number(length);
        } catch (err) {
            logger.warn({ err }, 'Redis health check failed');
        }

        // Mongo ping
        try {
            await clients.mongoClient.db(config.MONGO_DB_NAME).command({ ping: 1 });
            health.mongo = true;
        } catch (err) {
            logger.warn({ err }, 'MongoDB health check failed');
        }

        // Postgres ping
        try {
            await clients.pgPool.query('SELECT 1');
            health.postgres = true;
        } catch (err) {
            logger.warn({ err }, 'PostgreSQL health check failed');
        }

        logger.info({ health, metrics }, 'Health monitor');
    }, interval);

    return timer;
}

module.exports = {
    startHealthMonitor,
};
