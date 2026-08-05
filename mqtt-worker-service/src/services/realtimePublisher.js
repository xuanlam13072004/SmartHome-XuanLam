'use strict';

const { REDIS_CHANNELS } = require('../../../shared/constants');

class RealtimePublisher {
    constructor(redisClient, logger) {
        this.redis = redisClient;
        this.logger = logger;
    }

    async publishTelemetry(
        ownerId,
        mac,
        stateVersion,
        instances,
        diagnostics,
        observedAt,
        traceId = null,
    ) {
        const message = {
            owner_id: ownerId,
            mac,
            payload: {
                schema: 'device.state.patch.v2',
                state_version: stateVersion,
                instances,
                diagnostics,
            },
            timestamp: observedAt || new Date().toISOString(),
            ...(traceId ? { trace_id: traceId } : {}),
        };
        try {
            await this.redis.publish(
                REDIS_CHANNELS.DEVICE_TELEMETRY,
                JSON.stringify(message),
            );
        } catch (error) {
            this.logger.error({ error, device_id: mac }, 'Realtime telemetry publish failed');
        }
    }
}

module.exports = { RealtimePublisher };
