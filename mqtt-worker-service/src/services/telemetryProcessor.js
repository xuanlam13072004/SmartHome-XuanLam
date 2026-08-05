'use strict';

const crypto = require('crypto');
const { z } = require('zod');
const { CACHE_PREFIXES, REDIS_CHANNELS } = require('../../../shared/constants');
const { observeLatency } = require('../monitoring/metrics');
const { recordActivity } = require('./presenceManager');
const { validateInboundTransport } = require('./topologyRuntime');

class LRUMap {
    constructor(maxSize) {
        this.maxSize = maxSize;
        this.map = new Map();
    }
    get(key) {
        if (!this.map.has(key)) return undefined;
        const value = this.map.get(key);
        this.map.delete(key);
        this.map.set(key, value);
        return value;
    }
    set(key, value) {
        if (this.map.has(key)) this.map.delete(key);
        else if (this.map.size >= this.maxSize) this.map.delete(this.map.keys().next().value);
        this.map.set(key, value);
    }
    delete(key) { this.map.delete(key); }
}

let contextCache = new LRUMap(10000);
let invalidationSubscriber = null;
const CONTEXT_TTL_MS = 5 * 60 * 1000;

const reportedEnvelope = z.object({
    reported: z.record(z.any()),
}).strict();

const telemetrySchema = z.object({
    schema: z.literal('device.telemetry.v2'),
    event_id: z.string().min(8).max(200),
    device_id: z.string().transform(value => value.trim().toUpperCase()),
    product_id: z.string().regex(/^prod_[a-z0-9_]+$/),
    catalog_revision: z.coerce.number().int().positive(),
    state_version: z.coerce.number().int().nonnegative(),
    seq: z.coerce.number().int().nonnegative(),
    observed_at: z.string().datetime(),
    instances: z.record(reportedEnvelope),
    diagnostics: z.record(z.record(z.any())).default({}),
    trace_id: z.string().max(128).optional(),
    transport: z.object({
        mode: z.enum(['hub', 'relay', 'direct_fallback']),
        network_id: z.string().uuid(),
        topology_epoch: z.coerce.number().int().nonnegative(),
        hub_mac: z.string().optional(),
    }),
}).strict();

function initTelemetryProcessor(clients, _config, logger) {
    contextCache = new LRUMap(10000);
    invalidationSubscriber = clients.redis.duplicate({ lazyConnect: true });
    invalidationSubscriber.connect()
        .then(() => invalidationSubscriber.subscribe(
            REDIS_CHANNELS.DEVICE_CONTEXT_INVALIDATED,
            mac => contextCache.delete(String(mac).toUpperCase()),
        ))
        .catch(error => logger.error({ error }, 'Device context invalidation subscriber failed'));
    return async () => {
        if (invalidationSubscriber) await invalidationSubscriber.quit().catch(() => undefined);
    };
}

function getTelemetryDedupeId(telemetry) {
    return telemetry.event_id;
}

async function reserveTelemetry(redis, telemetry, config) {
    const key = `${config.REDIS_DEDUPE_PREFIX}${telemetry.event_id}`;
    const token = crypto.randomUUID();
    const result = await redis.set(
        key,
        token,
        'EX',
        config.TELEMETRY_DEDUPE_TTL_SECONDS,
        'NX',
    );
    return result === 'OK' ? { key, token, dedupeId: telemetry.event_id } : null;
}

async function releaseTelemetryReservation(redis, reservation) {
    if (!reservation) return;
    await redis.eval(
        `if redis.call('get', KEYS[1]) == ARGV[1] then
             return redis.call('del', KEYS[1])
         end
         return 0`,
        1,
        reservation.key,
        reservation.token,
    ).catch(() => undefined);
}

async function shouldProcessTelemetry(redis, telemetry, config) {
    return Boolean(await reserveTelemetry(redis, telemetry, config));
}

async function resolveDeviceContext(clients, deviceId, config, logger) {
    const cached = contextCache.get(deviceId);
    if (cached && cached.expiresAt > Date.now()) return cached.context;

    const keys = [
        `${CACHE_PREFIXES.OWNER_OF}${deviceId}`,
        `${CACHE_PREFIXES.PRODUCT_OF}${deviceId}`,
        `${CACHE_PREFIXES.CATALOG_REVISION_OF}${deviceId}`,
    ];
    try {
        const [ownerId, productId, revision] = await clients.redis.mget(...keys);
        if (ownerId && productId && revision) {
            const context = {
                ownerId,
                productId,
                catalogRevision: Number(revision),
            };
            contextCache.set(deviceId, { context, expiresAt: Date.now() + CONTEXT_TTL_MS });
            return context;
        }

        const shadow = await clients.mongoClient
            .db(config.MONGO_DB_NAME)
            .collection(config.MONGO_DEVICE_SHADOWS_COLLECTION)
            .findOne(
                { _id: deviceId },
                { projection: { owner_id: 1, product_id: 1, catalog_revision: 1 } },
            );
        if (!shadow?.owner_id || !shadow?.product_id || !shadow?.catalog_revision) {
            return { ownerId: null, productId: null, catalogRevision: null };
        }
        const context = {
            ownerId: shadow.owner_id,
            productId: shadow.product_id,
            catalogRevision: Number(shadow.catalog_revision),
        };
        await clients.redis
            .multi()
            .set(keys[0], context.ownerId, 'EX', config.REDIS_CACHE_TTL_SECONDS)
            .set(keys[1], context.productId, 'EX', config.REDIS_CACHE_TTL_SECONDS)
            .set(keys[2], String(context.catalogRevision), 'EX', config.REDIS_CACHE_TTL_SECONDS)
            .exec();
        contextCache.set(deviceId, { context, expiresAt: Date.now() + CONTEXT_TTL_MS });
        return context;
    } catch (error) {
        logger.error({ error, deviceId }, 'Unable to resolve device context');
        return { ownerId: null, productId: null, catalogRevision: null };
    }
}

async function processTelemetry(rawMessage, clients, config, logger, ingress = {}) {
    const startedAt = process.hrtime.bigint();
    const telemetry = telemetrySchema.parse(rawMessage);
    const deviceId = telemetry.device_id;
    const transport = await validateInboundTransport(
        clients.redis,
        {
            deviceId,
            topicOrigin: ingress.topicOrigin || deviceId,
            transport: telemetry.transport,
        },
        config,
    );
    const receipt = await clients.mongoClient
        .db(config.MONGO_DB_NAME)
        .collection(config.MONGO_INGEST_RECEIPTS_COLLECTION)
        .findOne({ event_id: telemetry.event_id }, { projection: { _id: 1 } });
    if (receipt) return null;

    const reservation = await reserveTelemetry(clients.redis, telemetry, config);
    if (!reservation) return null;
    try {
        const context = await resolveDeviceContext(clients, deviceId, config, logger);
        if (!context.ownerId || !context.productId || !context.catalogRevision) {
            throw new Error('Device is not actively claimed');
        }
        if (
            telemetry.product_id !== context.productId
            || telemetry.catalog_revision !== context.catalogRevision
        ) {
            throw new Error('Telemetry Product identity does not match the claimed device');
        }
        if (transport.owner_id !== context.ownerId) {
            throw new Error('Telemetry topology owner does not match device ownership');
        }
        const product = clients.catalog.getProduct(context.productId);
        if (!product || product.catalog_revision !== context.catalogRevision) {
            throw new Error('Published Product contract is unavailable');
        }

        const lastSequenceKey = `telemetry:last_seq:${deviceId}`;
        const lastSequence = await clients.redis.get(lastSequenceKey);
        if (lastSequence !== null && telemetry.seq > Number(lastSequence) + 1) {
            logger.warn(
                {
                    device_id: deviceId,
                    previous_seq: Number(lastSequence),
                    current_seq: telemetry.seq,
                    missing_count: telemetry.seq - Number(lastSequence) - 1,
                },
                'Telemetry sequence gap detected',
            );
        }
        await clients.redis.set(lastSequenceKey, String(telemetry.seq));

        const sanitized = clients.telemetrySanitizer.sanitize(telemetry, product);
        if (sanitized.warnings.length > 0) {
            logger.warn(
                { device_id: deviceId, warnings: sanitized.warnings },
                'Telemetry fields were rejected by the Product contract',
            );
        }
        const observedAt = new Date(telemetry.observed_at);
        const document = {
            _id: telemetry.event_id,
            event_id: telemetry.event_id,
            observed_at: observedAt,
            ingested_at: new Date(),
            metadata: {
                device_id: deviceId,
                owner_id: context.ownerId,
                product_id: context.productId,
                catalog_revision: context.catalogRevision,
                transport_mode: transport.mode,
                network_id: transport.network_id,
                topology_epoch: transport.topology_epoch,
                hub_mac: transport.hub_mac,
                mqtt_origin: transport.topic_origin,
            },
            seq: telemetry.seq,
            state_version: telemetry.state_version,
            instances: sanitized.instances,
            diagnostics: sanitized.diagnostics,
            trace_id: telemetry.trace_id || null,
        };
        if (!clients.telemetryWriter.add(document)) {
            throw new Error('Telemetry persistence queue is full');
        }
        clients.shadowWriter.add(deviceId, context, {
            stateVersion: telemetry.state_version,
            instances: sanitized.instances,
            diagnostics: sanitized.diagnostics,
            activitySource: `telemetry:${transport.mode}`,
        });
        await clients.realtimePublisher.publishTelemetry(
            context.ownerId,
            deviceId,
            telemetry.state_version,
            sanitized.instances,
            sanitized.diagnostics,
            telemetry.observed_at,
            telemetry.trace_id || null,
        );
        await recordActivity(
            clients,
            deviceId,
            context.ownerId,
            `telemetry:${transport.mode}`,
            config,
            logger,
        );
        if (transport.mode === 'relay' && transport.hub_mac !== deviceId) {
            await recordActivity(
                clients,
                transport.hub_mac,
                context.ownerId,
                'relay_telemetry',
                config,
                logger,
            );
        }
        observeLatency(Number(process.hrtime.bigint() - startedAt) / 1e9);
        return deviceId;
    } catch (error) {
        await releaseTelemetryReservation(clients.redis, reservation);
        throw error;
    }
}

module.exports = {
    getTelemetryDedupeId,
    initTelemetryProcessor,
    processTelemetry,
    resolveDeviceContext,
    shouldProcessTelemetry,
};
