const { recordShadowRetry } = require('../monitoring/metrics');

/**
 * mqtt-worker-service/src/services/shadowBatchWriter.js
 * 
 * Lớp quản lý ghi trạng thái Device Shadows theo lô với cơ chế Double-Buffering
 * và phục hồi Exactly-Once dùng Revision/Updated-at.
 */

class ShadowBatchWriter {
    constructor(mongoClient, config, logger) {
        this.mongoClient = mongoClient;
        this.config = config;
        this.logger = logger;

        this.shadowBatchMap = new Map(); // MAC -> { device_id, revision, updateDoc, updated_at }
        this.processingShadowBatch = new Map();
        this.flushTimer = null;
        this.flushInProgress = false;
        this.isGracefulShutdown = false;

        this.stats = {
            shadow_batch_retry_total: 0
        };
    }

    /**
     * Thêm/Trộn bản cập nhật shadow vào Map đệm trong RAM
     */
    add(mac, ownerId, sanitized) {
        if (this.isGracefulShutdown) return;

        let existing = this.shadowBatchMap.get(mac);
        if (!existing) {
            existing = {
                device_id: mac,
                revision: 1,
                updateDoc: {
                    owner_id: ownerId,
                    last_updated: new Date(),
                    last_seen: new Date(),
                    is_online: true,
                    revision: 1
                },
                updated_at: Date.now()
            };
            this.shadowBatchMap.set(mac, existing);
        } else {
            existing.revision++;
            existing.updated_at = Date.now();
            existing.updateDoc.last_updated = new Date();
            existing.updateDoc.last_seen = new Date();
            existing.updateDoc.is_online = true;
            existing.updateDoc.revision = existing.revision;
        }

        // Ghi các trường state (merge)
        for (const [k, v] of Object.entries(sanitized.stateUpdates)) {
            existing.updateDoc[`state.${k}`] = v;
        }

        // Ghi các trường diagnostics (merge)
        for (const [k, v] of Object.entries(sanitized.diagnosticUpdates)) {
            existing.updateDoc[`diagnostics.${k}`] = v;
        }

        if (this.shadowBatchMap.size >= this.config.TELEMETRY_BATCH_SIZE) {
            this.triggerFlush();
        } else {
            this.scheduleFlush();
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
        if (this.shadowBatchMap.size === 0) return;

        this.flushInProgress = true;

        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }

        // 1. Sao chép dữ liệu sang processingShadowBatch (Double-Buffering) và xóa sạch Map chính
        this.processingShadowBatch = new Map(this.shadowBatchMap);
        this.shadowBatchMap.clear();

        const db = this.mongoClient.db(this.config.MONGO_DB_NAME);
        const devicesCollection = db.collection(this.config.MONGO_DEVICES_COLLECTION);

        // Chuẩn bị các operation bulkWrite
        const shadowOps = [];
        for (const [mac, entry] of this.processingShadowBatch.entries()) {
            shadowOps.push({
                updateOne: {
                    filter: { _id: mac },
                    update: { $set: entry.updateDoc },
                    upsert: true
                }
            });
        }

        try {
            const startTime = Date.now();
            const result = await devicesCollection.bulkWrite(shadowOps, { ordered: false });
            const duration = Date.now() - startTime;

            this.logger.debug(
                { matched: result.matchedCount, upserted: result.upsertedCount, duration_ms: duration },
                'Shadow bulk updates completed successfully'
            );

            // Ghi nhận thành công: dọn sạch hàng đợi đang xử lý
            this.processingShadowBatch.clear();
        } catch (err) {
            this.stats.shadow_batch_retry_total++;
            try {
                recordShadowRetry();
            } catch (mErr) {}
            this.logger.error({ err }, 'Failed to bulk write shadow updates, merging back for retry');

            // Ghi nhận thất bại: Khôi phục trộn ngược dữ liệu (Merge-back) theo nguyên tắc Exactly-Once
            this.mergeBackFailedUpdates();
        } finally {
            this.flushInProgress = false;

            if (this.shadowBatchMap.size > 0) {
                this.scheduleFlush();
            }
        }
    }

    /**
     * Khôi phục trộn ngược dữ liệu (Exactly-Once)
     */
    mergeBackFailedUpdates() {
        for (const [mac, failedEntry] of this.processingShadowBatch.entries()) {
            const current = this.shadowBatchMap.get(mac);

            if (!current) {
                // Nếu chưa có update mới trong RAM, khôi phục nguyên bản cũ
                this.shadowBatchMap.set(mac, failedEntry);
            } else {
                // Nếu đã có update mới trong RAM (revision tăng)
                if (current.revision <= failedEntry.revision) {
                    // Trong thực tế điều này khó xảy ra do current.revision phải lớn hơn,
                    // nhưng nếu có thì khôi phục hoàn toàn
                    current.updateDoc = { ...failedEntry.updateDoc, ...current.updateDoc };
                    current.revision = failedEntry.revision;
                } else {
                    // Nếu revision hiện tại mới hơn, chỉ merge các key từ bản cũ nếu bản mới chưa có
                    for (const [k, v] of Object.entries(failedEntry.updateDoc)) {
                        if (current.updateDoc[k] === undefined) {
                            current.updateDoc[k] = v;
                        }
                    }
                }
            }
        }
        this.processingShadowBatch.clear();
    }

    /**
     * Dọn dẹp hàng đợi shadow trước khi tắt máy
     */
    async shutdown() {
        this.isGracefulShutdown = true;
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }

        // Gom toàn bộ còn lại ở cả 2 Map
        const finalMap = new Map();
        
        // Trộn các failed cũ trước
        for (const [mac, entry] of this.processingShadowBatch.entries()) {
            finalMap.set(mac, entry.updateDoc);
        }
        // Trộn các pending mới
        for (const [mac, entry] of this.shadowBatchMap.entries()) {
            const existing = finalMap.get(mac);
            if (!existing) {
                finalMap.set(mac, entry.updateDoc);
            } else {
                finalMap.set(mac, { ...existing, ...entry.updateDoc });
            }
        }

        if (finalMap.size === 0) {
            this.logger.info('ShadowBatchWriter: No pending shadow updates on shutdown.');
            return;
        }

        this.logger.info({ count: finalMap.size }, 'ShadowBatchWriter: Flushing remaining shadow updates on shutdown...');
        
        const shadowOps = [];
        for (const [mac, updateDoc] of finalMap.entries()) {
            shadowOps.push({
                updateOne: {
                    filter: { _id: mac },
                    update: { $set: updateDoc },
                    upsert: true
                }
            });
        }

        try {
            const db = this.mongoClient.db(this.config.MONGO_DB_NAME);
            const devicesCollection = db.collection(this.config.MONGO_DEVICES_COLLECTION);
            await devicesCollection.bulkWrite(shadowOps, { ordered: false });
            this.logger.info('ShadowBatchWriter: All remaining shadow updates flushed successfully.');
        } catch (err) {
            this.logger.error({ err }, 'ShadowBatchWriter: Failed to flush remaining shadow updates on shutdown (data loss occurred)');
        }
    }
}

module.exports = {
    ShadowBatchWriter,
};
