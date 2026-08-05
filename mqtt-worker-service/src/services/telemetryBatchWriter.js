'use strict';

const { recordTelemetryRetry } = require('../monitoring/metrics');

class TelemetryBatchWriter {
    constructor(mongoClient, mqttClient, config, logger) {
        this.mongoClient = mongoClient;
        this.mqttClient = mqttClient;
        this.config = config;
        this.logger = logger;
        this.queue = [];
        this.flushTimer = null;
        this.flushing = false;
        this.stopping = false;
        this.maxAttempts = 5;
        this.stats = {
            processed: 0,
            accepted: 0,
            rejected: 0,
            write_success: 0,
            write_failure: 0,
            retry_count: 0,
            dropped_due_to_limit: 0,
            dropped_due_to_retry_limit: 0,
        };
    }

    add(document) {
        this.stats.processed += 1;
        if (this.stopping || this.queue.length >= this.config.TELEMETRY_BUFFER_MAX) {
            this.stats.rejected += 1;
            this.stats.dropped_due_to_limit += 1;
            return false;
        }
        this.queue.push({ document, attempts: 0 });
        this.stats.accepted += 1;
        if (this.queue.length >= this.config.TELEMETRY_BATCH_SIZE) void this.flush();
        else this.schedule();
        return true;
    }

    schedule() {
        if (this.flushTimer || this.flushing || this.stopping) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            void this.flush();
        }, this.config.TELEMETRY_BATCH_FLUSH_MS);
        this.flushTimer.unref();
    }

    async writeBatch(entries) {
        const db = this.mongoClient.db(this.config.MONGO_DB_NAME);
        const telemetry = db.collection(this.config.MONGO_TELEMETRY_COLLECTION);
        try {
            await telemetry.bulkWrite(
                entries.map(entry => ({ insertOne: { document: entry.document } })),
                { ordered: false },
            );
        } catch (error) {
            const writeErrors = error?.writeErrors || [];
            if (writeErrors.length === 0 || writeErrors.some(item => item.code !== 11000)) {
                throw error;
            }
        }

        const now = new Date();
        const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        await db.collection(this.config.MONGO_INGEST_RECEIPTS_COLLECTION).bulkWrite(
            entries.map(entry => ({
                updateOne: {
                    filter: { event_id: entry.document.event_id },
                    update: {
                        $setOnInsert: {
                            event_id: entry.document.event_id,
                            device_id: entry.document.metadata.device_id,
                            received_at: now,
                            expires_at: expiresAt,
                        },
                    },
                    upsert: true,
                },
            })),
            { ordered: false },
        );
    }

    async flush() {
        if (this.flushing || this.queue.length === 0) return;
        this.flushing = true;
        const batch = this.queue.splice(0, this.config.TELEMETRY_BATCH_SIZE);
        try {
            await this.writeBatch(batch);
            this.stats.write_success += batch.length;
        } catch (error) {
            this.stats.write_failure += batch.length;
            const retry = [];
            for (const entry of batch) {
                entry.attempts += 1;
                if (entry.attempts <= this.maxAttempts) retry.push(entry);
                else this.stats.dropped_due_to_retry_limit += 1;
            }
            this.stats.retry_count += retry.length;
            if (retry.length > 0) {
                try { recordTelemetryRetry(); } catch {}
                this.queue.unshift(...retry);
            }
            this.logger.error(
                { error, retrying: retry.length },
                'Telemetry batch write failed',
            );
        } finally {
            this.flushing = false;
            if (this.queue.length > 0 && !this.stopping) this.schedule();
        }
    }

    getQueueLength() {
        return this.queue.length;
    }

    getRetryQueueCount() {
        return this.queue.filter(entry => entry.attempts > 0).length;
    }

    async shutdown() {
        this.stopping = true;
        if (this.flushTimer) clearTimeout(this.flushTimer);
        while (this.queue.length > 0) await this.flush();
    }
}

module.exports = { TelemetryBatchWriter };
