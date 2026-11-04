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

    async publishDeviceEvent(ownerId, mac, eventDocument) {
        const message = {
            owner_id: ownerId,
            mac,
            payload: {
                event_id: eventDocument.event_id,
                instance_id: eventDocument.instance_id,
                capability_id: eventDocument.capability_id,
                event_name: eventDocument.event_name,
                severity: eventDocument.severity,
                data: eventDocument.data,
                occurred_at: eventDocument.occurred_at,
                received_at: eventDocument.received_at,
                transport: eventDocument.transport,
            },
            timestamp: eventDocument.received_at.toISOString(),
        };
        try {
            await this.redis.publish(
                REDIS_CHANNELS.DEVICE_EVENT,
                JSON.stringify(message),
            );
        } catch (error) {
            this.logger.error({ error, device_id: mac }, 'Realtime device-event publish failed');
        }
    }
}

module.exports = { RealtimePublisher };
