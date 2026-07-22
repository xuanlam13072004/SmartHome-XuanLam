const { recordTelemetryRetry } = require('../monitoring/metrics');

/**
 * mqtt-worker-service/src/services/telemetryBatchWriter.js
 * 
 * Lớp dịch vụ quản lý ghi nhật ký Telemetry Logs theo lô (MongoDB time-series)
 * tích hợp retry queue độc lập, Exponential Backoff và Backpressure (MQTT unsub/resub).
 */

class TelemetryBatchWriter {
    /**
     * @param {object} mongoClient - MongoClient kết nối tới MongoDB
     * @param {object} mqttClient - MQTT Client kết nối tới broker (phục vụ backpressure)
     * @param {object} config - Cấu hình hệ thống
     * @param {object} logger - Logger instance
     */
    constructor(mongoClient, mqttClient, config, logger) {
        this.mongoClient = mongoClient;
        this.mqttClient = mqttClient;
        this.config = config;
        this.logger = logger;

        this.queue = []; // Hàng đợi chính lưu trữ các document mới
        this.retryQueue = []; // Hàng đợi lưu các lô bị lỗi: { docs, attempts, nextRetryAt }
        this.flushTimer = null;
        this.flushInProgress = false;
        this.isGracefulShutdown = false;
        this.isUnsubscribed = false;

        // Cấu hình giới hạn bộ nhớ (Memory Limit) & Backpressure
        this.HIGH_WATER_MARK = 50000; // Ngưỡng unsubscribe
        this.LOW_WATER_MARK = 10000;  // Ngưỡng resubscribe
        this.MAX_RETRY_ATTEMPTS = 5;

        // Thống kê metrics
        this.stats = {
            processed: 0,
            accepted: 0,
            rejected: 0,
            write_success: 0,
            write_failure: 0,
            retry_count: 0,
            dropped_due_to_limit: 0,
            dropped_due_to_retry_limit: 0
        };

        // Xác định telemetry topic phục vụ unsub/resub
        const sharedPrefix = this.config.MQTT_SHARED_GROUP
            ? `$share/${this.config.MQTT_SHARED_GROUP}/`
            : '';
        this.telemetryTopic = `${sharedPrefix}${this.config.MQTT_TELEMETRY_TOPIC}`;
    }

    /**
     * Thêm một document telemetry log vào hàng đợi
     * @param {object} doc - Document telemetry log chuẩn
     */
    add(doc) {
        if (this.isGracefulShutdown) return false;

        const totalLength = this.queue.length + this.getRetryQueueCount();

        // 1. Kiểm tra memory limit cứng (ví dụ: tối đa 60,000 tin để tránh OOM hoàn toàn)
        if (totalLength >= this.HIGH_WATER_MARK + 10000) {
            this.stats.dropped_due_to_limit++;
            this.stats.rejected++;
            this.logger.error(
                { mac: doc.metadata?.device_id, queue_size: totalLength },
                'TelemetryBatchWriter: Hard limit exceeded! Dropping telemetry log to prevent OOM.'
            );
            return false;
        }

        this.queue.push(doc);
        this.stats.processed++;
        this.stats.accepted++;

        // 2. Kích hoạt backpressure nếu đạt High Water Mark
        this.checkBackpressure(totalLength + 1);

        // 3. Lên lịch flush hoặc flush ngay nếu đủ lô
        if (this.queue.length >= this.config.TELEMETRY_BATCH_SIZE) {
            this.triggerFlush();
        } else {
            this.scheduleFlush();
        }
        return true;
    }

    getRetryableDocs(err, docs) {
        const writeConcernErrors = err?.writeConcernErrors || err?.result?.writeConcernErrors;
        if (Array.isArray(writeConcernErrors) && writeConcernErrors.length > 0) return docs;
        const writeErrors = Array.isArray(err?.writeErrors) ? err.writeErrors : null;
        if (!writeErrors) return docs;

        const retryableIndexes = new Set();
        for (const writeError of writeErrors) {
            const code = writeError.code ?? writeError.err?.code;
            const index = writeError.index ?? writeError.err?.index;
            if (code !== 11000 && Number.isInteger(index)) retryableIndexes.add(index);
        }
        return docs.filter((_, index) => retryableIndexes.has(index));
    }

    /**
     * Lấy tổng số document đang nằm trong hàng đợi retry
     */
    getRetryQueueCount() {
        return this.retryQueue.reduce((acc, item) => acc + item.docs.length, 0);
    }

    /**
     * Kiểm tra trạng thái hàng đợi và thực hiện backpressure
     */
    checkBackpressure(currentLength) {
        if (!this.mqttClient) return;

        if (currentLength >= this.HIGH_WATER_MARK && !this.isUnsubscribed) {
            this.isUnsubscribed = true;
            this.logger.warn(
                { queue_size: currentLength, topic: this.telemetryTopic },
                'TelemetryBatchWriter: High water mark reached! Unsubscribing from MQTT telemetry topic (Backpressure ON).'
            );
            this.mqttClient.unsubscribe(this.telemetryTopic, (err) => {
                if (err) {
                    this.logger.error({ err }, 'TelemetryBatchWriter: Failed to unsubscribe from MQTT telemetry topic');
                }
            });
        } else if (currentLength <= this.LOW_WATER_MARK && this.isUnsubscribed) {
            this.isUnsubscribed = false;
            this.logger.info(
                { queue_size: currentLength, topic: this.telemetryTopic },
                'TelemetryBatchWriter: Queue cleared below low water mark. Resubscribing to MQTT telemetry topic (Backpressure OFF).'
            );
            this.mqttClient.subscribe(this.telemetryTopic, { qos: 1 }, (err) => {
                if (err) {
                    this.logger.error({ err }, 'TelemetryBatchWriter: Failed to resubscribe to MQTT telemetry topic');
                    this.isUnsubscribed = true; // Trả lại trạng thái nếu subscribe lỗi
                }
            });
        }
    }

    scheduleFlush() {
        if (this.flushTimer || this.flushInProgress || this.isGracefulShutdown) return;

        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.triggerFlush();
        }, this.config.TELEMETRY_BATCH_FLUSH_MS);
    }

    async triggerFlush() {
        if (this.flushInProgress || this.isGracefulShutdown) return;
        
        const now = Date.now();
        // Lấy các failed batches đã đến hạn retry
        const readyRetries = this.retryQueue.filter(item => now >= item.nextRetryAt);
        
        if (this.queue.length === 0 && readyRetries.length === 0) return;

        this.flushInProgress = true;

        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }

        const db = this.mongoClient.db(this.config.MONGO_DB_NAME);
        const telemetryCollection = db.collection(this.config.MONGO_TELEMETRY_COLLECTION);

        // 1. Thực hiện xử lý retry trước
        if (readyRetries.length > 0) {
            this.logger.info({ count: readyRetries.length }, 'TelemetryBatchWriter: Retrying failed telemetry batches');
            for (const retryItem of readyRetries) {
                try {
                    await telemetryCollection.insertMany(retryItem.docs, { ordered: false });
                    this.stats.write_success += retryItem.docs.length;
                    
                    // Xóa khỏi retryQueue
                    this.retryQueue = this.retryQueue.filter(item => item !== retryItem);
                    this.logger.debug({ docs_count: retryItem.docs.length }, 'TelemetryBatchWriter: Retry batch write success');
                } catch (err) {
                    const retryableDocs = this.getRetryableDocs(err, retryItem.docs);
                    this.stats.write_success += retryItem.docs.length - retryableDocs.length;
                    if (retryableDocs.length === 0) {
                        this.retryQueue = this.retryQueue.filter(item => item !== retryItem);
                        this.logger.debug({ docs_count: retryItem.docs.length }, 'TelemetryBatchWriter: Retry contained only already-persisted duplicates');
                        continue;
                    }
                    retryItem.docs = retryableDocs;
                    this.stats.retry_count++;
                    try {
                        recordTelemetryRetry();
                    } catch (mErr) {}
                    retryItem.attempts++;
                    
                    if (retryItem.attempts > this.MAX_RETRY_ATTEMPTS) {
                        this.stats.dropped_due_to_retry_limit += retryItem.docs.length;
                        this.retryQueue = this.retryQueue.filter(item => item !== retryItem);
                        this.logger.error(
                            { err, attempts: retryItem.attempts, docs_count: retryItem.docs.length },
                            'TelemetryBatchWriter: Retry limit exceeded! Dropping failed batch to prevent infinite loop (data loss occurred).'
                        );
                    } else {
                        // Tính toán exponential backoff: 2s, 4s, 8s, 16s, 30s
                        const backoffMs = Math.min(1000 * Math.pow(2, retryItem.attempts), 30000);
                        retryItem.nextRetryAt = Date.now() + backoffMs;
                        this.logger.warn(
                            { err, attempts: retryItem.attempts, nextRetryInMs: backoffMs },
                            'TelemetryBatchWriter: Retry attempt failed, rescheduling with exponential backoff.'
                        );
                    }
                }
            }
        }

        // 2. Thực hiện ghi lô mới
        if (this.queue.length > 0) {
            const batchToInsert = this.queue.splice(0, this.config.TELEMETRY_BATCH_SIZE);
            try {
                const startTime = Date.now();
                await telemetryCollection.insertMany(batchToInsert, { ordered: false });
                const duration = Date.now() - startTime;

                this.stats.write_success += batchToInsert.length;
                this.logger.debug(
                    { inserted: batchToInsert.length, duration_ms: duration },
                    'TelemetryBatchWriter: Telemetry batch inserted successfully'
                );
            } catch (err) {
                const retryableDocs = this.getRetryableDocs(err, batchToInsert);
                this.stats.write_success += batchToInsert.length - retryableDocs.length;
                this.stats.write_failure += retryableDocs.length;
                try {
                    recordTelemetryRetry();
                } catch (mErr) {}
                this.logger.error({ err, batch_size: batchToInsert.length, retryable: retryableDocs.length }, 'TelemetryBatchWriter: Failed to insert part of telemetry batch');
                
                if (retryableDocs.length > 0) {
                    // Retry only documents that did not persist. Duplicate-key rows are already durable.
                    this.retryQueue.push({
                        docs: retryableDocs,
                        attempts: 1,
                        nextRetryAt: Date.now() + 2000
                    });
                }
            }
        }

        this.flushInProgress = false;

        // Cập nhật lại backpressure sau khi giải phóng hàng đợi
        const currentLength = this.queue.length + this.getRetryQueueCount();
        this.checkBackpressure(currentLength);

        // Tiếp tục lên lịch flush nếu còn dữ liệu
        if (this.queue.length > 0 || this.retryQueue.some(item => Date.now() >= item.nextRetryAt)) {
            this.scheduleFlush();
        }
    }

    /**
     * Trả về thông số hoạt động của Batch Writer
     */
    getMetrics() {
        return {
            queue_length: this.queue.length,
            retry_queue_length: this.getRetryQueueCount(),
            is_unsubscribed: this.isUnsubscribed,
            ...this.stats
        };
    }

    /**
     * Dọn dẹp và flush toàn bộ dữ liệu trước khi shutdown
     */
    async shutdown() {
        this.isGracefulShutdown = true;
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }

        // Gom tất cả documents từ queue chính và retryQueue
        const finalDocs = [...this.queue];
        for (const item of this.retryQueue) {
            finalDocs.push(...item.docs);
        }

        this.queue = [];
        this.retryQueue = [];

        if (finalDocs.length === 0) {
            this.logger.info('TelemetryBatchWriter: No pending telemetry logs on shutdown.');
            return;
        }

        this.logger.info({ count: finalDocs.length }, 'TelemetryBatchWriter: Flushing remaining telemetry logs on shutdown...');
        
        try {
            const db = this.mongoClient.db(this.config.MONGO_DB_NAME);
            const telemetryCollection = db.collection(this.config.MONGO_TELEMETRY_COLLECTION);
            
            // Chia nhỏ ra từng batch kích thước tối đa để insert
            const batchSize = this.config.TELEMETRY_BATCH_SIZE;
            for (let i = 0; i < finalDocs.length; i += batchSize) {
                const chunk = finalDocs.slice(i, i + batchSize);
                await telemetryCollection.insertMany(chunk, { ordered: false });
            }
            
            this.logger.info('TelemetryBatchWriter: All remaining telemetry logs flushed successfully.');
        } catch (err) {
            this.logger.error({ err }, 'TelemetryBatchWriter: Failed to flush remaining telemetry logs on shutdown (data loss occurred)');
        }
    }
}

module.exports = {
    TelemetryBatchWriter
};
