/**
 * mqtt-worker-service/src/services/realtimePublisher.js
 * 
 * Lớp dịch vụ quản lý xuất bản dữ liệu thời gian thực (Realtime Publisher)
 * qua hệ thống Redis Pub/Sub cho Realtime WebSocket Service.
 */

const { REDIS_CHANNELS } = require('../../../shared/constants');

class RealtimePublisher {
    /**
     * @param {object} redisClient - Redis client kết nối của hệ thống
     * @param {object} logger - Logger instance
     */
    constructor(redisClient, logger) {
        this.redis = redisClient;
        this.logger = logger;
    }

    /**
     * Publish dữ liệu telemetry đã lọc lên Redis Pub/Sub
     * 
     * @param {string} ownerId - Owner UUID
     * @param {string} mac - Địa chỉ MAC của thiết bị
     * @param {Object} sanitizedState - Trạng thái state hợp lệ
     * @param {Object} sanitizedDiagnostics - Thông số diagnostics hợp lệ
     * @param {string} timestamp - Thời gian báo cáo
     */
    async publishTelemetry(ownerId, mac, sanitizedState, sanitizedDiagnostics, timestamp, traceId = null) {
        const payload = {
            owner_id: ownerId,
            mac: mac,
            payload: {
                state: sanitizedState,
                diagnostics: sanitizedDiagnostics
            },
            timestamp: timestamp || new Date().toISOString()
        };
        if (traceId) {
            payload.trace_id = traceId;
        }

        try {
            await this.redis.publish(
                REDIS_CHANNELS.DEVICE_TELEMETRY,
                JSON.stringify(payload)
            );
            this.logger.debug({ device_id: mac }, 'RealtimePublisher: Telemetry published successfully');
        } catch (err) {
            this.logger.error({ err, device_id: mac }, 'RealtimePublisher: Failed to publish telemetry update');
        }
    }

    /**
     * Publish trạng thái lệnh điều khiển lên Redis Pub/Sub
     */
    async publishCommandUpdate(ownerId, mac, commandId, status, eventVersion, errorLog = null) {
        const payload = {
            owner_id: ownerId,
            mac: mac,
            payload: {
                command_id: commandId,
                status,
                event_version: eventVersion,
                error_log: errorLog
            },
            timestamp: new Date().toISOString()
        };

        try {
            await this.redis.publish(
                REDIS_CHANNELS.DEVICE_COMMAND,
                JSON.stringify(payload)
            );
            this.logger.debug({ command_id: commandId, status }, 'RealtimePublisher: Command status update published');
        } catch (err) {
            this.logger.error({ err, command_id: commandId }, 'RealtimePublisher: Failed to publish command status update');
        }
    }
}

module.exports = {
    RealtimePublisher
};
