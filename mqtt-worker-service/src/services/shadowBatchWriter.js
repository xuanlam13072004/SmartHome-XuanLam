'use strict';

const { recordShadowRetry } = require('../monitoring/metrics');

function flatten(prefix, value, target) {
    for (const [key, nested] of Object.entries(value || {})) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
            flatten(path, nested, target);
        } else target[path] = nested;
    }
}

class ShadowBatchWriter {
    constructor(mongoClient, config, logger) {
        this.mongoClient = mongoClient;
        this.config = config;
        this.logger = logger;
        this.pending = new Map();
        this.flushTimer = null;
        this.flushing = false;
        this.stopping = false;
        this.stats = { shadow_batch_retry_total: 0 };
    }

    add(mac, context, update) {
        if (this.stopping) return false;
        const stateVersion = Number(update.stateVersion);
        const current = this.pending.get(mac);
        if (current && current.stateVersion > stateVersion) return true;
        const fields = current ? { ...current.fields } : {};
        flatten('instances', update.instances, fields);
        flatten('diagnostics', update.diagnostics, fields);
        const now = new Date();
        Object.assign(fields, {
            state_version: stateVersion,
            is_online: true,
            last_seen: now,
            updated_at: now,
            last_activity_source: update.activitySource,
        });
        this.pending.set(mac, {
            ownerId: context.ownerId,
            productId: context.productId,
            catalogRevision: context.catalogRevision,
            stateVersion,
            fields,
            attempts: current?.attempts || 0,
        });
        if (this.pending.size >= this.config.TELEMETRY_BATCH_SIZE) void this.flush();
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

    async flush() {
        if (this.flushing || this.pending.size === 0) return;
        this.flushing = true;
        const batch = [...this.pending.entries()].slice(0, this.config.TELEMETRY_BATCH_SIZE);
        for (const [mac] of batch) this.pending.delete(mac);
        try {
            const collection = this.mongoClient
                .db(this.config.MONGO_DB_NAME)
                .collection(this.config.MONGO_DEVICE_SHADOWS_COLLECTION);
            await collection.bulkWrite(
                batch.map(([mac, entry]) => ({
                    updateOne: {
                        filter: {
                            _id: mac,
                            owner_id: entry.ownerId,
                            product_id: entry.productId,
                            catalog_revision: entry.catalogRevision,
                            state_version: { $lt: entry.stateVersion },
                        },
                        update: { $set: entry.fields },
                    },
                })),
                { ordered: false },
            );
        } catch (error) {
            this.stats.shadow_batch_retry_total += batch.length;
            try { recordShadowRetry(); } catch {}
            for (const [mac, entry] of batch) {
                entry.attempts += 1;
                if (entry.attempts <= 5 && !this.pending.has(mac)) this.pending.set(mac, entry);
            }
            this.logger.error({ error }, 'Device shadow batch write failed');
        } finally {
            this.flushing = false;
            if (this.pending.size > 0 && !this.stopping) this.schedule();
        }
    }

    async shutdown() {
        this.stopping = true;
        if (this.flushTimer) clearTimeout(this.flushTimer);
        while (this.pending.size > 0) await this.flush();
    }
}

module.exports = { ShadowBatchWriter, flatten };
