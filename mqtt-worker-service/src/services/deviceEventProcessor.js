'use strict';

const { z } = require('zod');
const { validateObjectAgainstSchema } = require('../../../shared/validation');
const { recordActivity } = require('./presenceManager');
const { resolveDeviceContext } = require('./telemetryProcessor');
const { validateInboundTransport } = require('./topologyRuntime');

const identifier = /^[a-z][a-z0-9_]{1,63}$/;
const forbiddenDataKey = /(^|_)(pin|password|secret|raw_key|key_sequence|digits)($|_)/i;
const sixDigitSecret = /(?:^|\D)\d{6}(?:\D|$)/;
const MAX_DEVICE_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

const transportSchema = z.object({
    mode: z.enum(['hub', 'relay', 'direct_fallback']),
    network_id: z.string().uuid(),
    topology_epoch: z.coerce.number().int().nonnegative(),
    hub_mac: z.string().optional(),
}).strict();

const deviceEventSchema = z.object({
    schema: z.literal('device.event.v2'),
    event_id: z.string().min(8).max(200),
    device_id: z.string().transform(value => value.trim().toUpperCase()),
    product_id: z.string().regex(/^prod_[a-z0-9_]+$/),
    catalog_revision: z.coerce.number().int().positive(),
    seq: z.coerce.number().int().nonnegative(),
    instance_id: z.string().regex(identifier),
    event_name: z.string().regex(identifier),
    data: z.record(z.any()).default({}),
    occurred_at: z.string().datetime().optional(),
    device_uptime_ms: z.coerce.number().int().nonnegative().optional(),
    trace_id: z.string().max(128).optional(),
    transport: transportSchema,
}).strict();

function assertNoSensitiveKeys(value, path = 'data') {
    if (typeof value === 'string' && sixDigitSecret.test(value)) {
        throw new Error(`Possible raw six-digit PIN at '${path}' is forbidden`);
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
        value.forEach((item, index) => assertNoSensitiveKeys(item, `${path}[${index}]`));
        return;
    }
    for (const [key, nested] of Object.entries(value)) {
        if (forbiddenDataKey.test(key)) {
            throw new Error(`Sensitive device-event field '${path}.${key}' is forbidden`);
        }
        assertNoSensitiveKeys(nested, `${path}.${key}`);
    }
}

function validateCatalogEvent(deviceEvent, product) {
    const key = `${deviceEvent.instance_id}.${deviceEvent.event_name}`;
    const definition = product.events?.[key];
    if (!definition || definition.producer !== 'device_firmware') {
        throw new Error(`Event '${key}' is not declared for this Product`);
    }
    assertNoSensitiveKeys(deviceEvent.data);
    const validation = validateObjectAgainstSchema(deviceEvent.data, definition.data || {});
    if (!validation.valid) {
        throw new Error(`Event '${key}' data is invalid: ${validation.error}`);
    }
    return definition;
}

function buildDeviceEventDocument(
    deviceEvent,
    context,
    definition,
    transport,
    receivedAt = new Date(),
) {
    const deviceOccurredAt = deviceEvent.occurred_at
        ? new Date(deviceEvent.occurred_at)
        : null;
    const deviceTimeTrusted = deviceOccurredAt !== null
        && Number.isFinite(deviceOccurredAt.getTime())
        && Math.abs(receivedAt.getTime() - deviceOccurredAt.getTime()) <= MAX_DEVICE_CLOCK_SKEW_MS;
    const occurredAt = deviceTimeTrusted ? deviceOccurredAt : receivedAt;
    return {
        _id: deviceEvent.event_id,
        event_id: deviceEvent.event_id,
        device_id: deviceEvent.device_id,
        owner_id: context.ownerId,
        product_id: context.productId,
        catalog_revision: context.catalogRevision,
        capability_id: definition.capability_id,
        instance_id: deviceEvent.instance_id,
        event_name: deviceEvent.event_name,
        // Keep the established V2 event aliases while newer consumers migrate
        // to the catalog-native event_name field.
        type: deviceEvent.event_name,
        severity: definition.severity,
        retention: definition.retention,
        source: 'device',
        data: deviceEvent.data,
        seq: deviceEvent.seq,
        device_uptime_ms: deviceEvent.device_uptime_ms ?? null,
        occurred_at: occurredAt,
        received_at: receivedAt,
        device_time_trusted: deviceTimeTrusted,
        transport: {
            mode: transport.mode,
            network_id: transport.network_id,
            topology_epoch: transport.topology_epoch,
            hub_mac: transport.hub_mac ?? null,
            mqtt_origin: transport.topic_origin,
        },
        trace_id: deviceEvent.trace_id || null,
    };
}

async function ensureDeviceEventIndexes(mongoClient, config) {
    const collection = mongoClient
        .db(config.MONGO_DB_NAME)
        .collection(config.MONGO_DEVICE_EVENTS_COLLECTION);
    await Promise.all([
        collection.createIndex(
            { device_id: 1, event_id: 1 },
            { unique: true, name: 'device_event_identity_unique' },
        ),
        collection.createIndex(
            { device_id: 1, received_at: -1, _id: -1 },
            { name: 'device_event_device_timeline' },
        ),
        collection.createIndex(
            { owner_id: 1, received_at: -1 },
            { name: 'device_event_owner_timeline' },
        ),
        collection.createIndex(
            { event_name: 1, received_at: -1 },
            { name: 'device_event_type_timeline' },
        ),
    ]);
}

async function processDeviceEvent(rawMessage, clients, config, logger, ingress = {}) {
    const deviceEvent = deviceEventSchema.parse(rawMessage);
    const deviceId = deviceEvent.device_id;
    const transport = await validateInboundTransport(
        clients.redis,
        {
            deviceId,
            topicOrigin: ingress.topicOrigin || deviceId,
            transport: deviceEvent.transport,
        },
        config,
    );
    const context = await resolveDeviceContext(clients, deviceId, config, logger);
    if (!context.ownerId || !context.productId || !context.catalogRevision) {
        throw new Error('Device is not actively claimed');
    }
    if (
        deviceEvent.product_id !== context.productId
        || deviceEvent.catalog_revision !== context.catalogRevision
    ) {
        throw new Error('Device event Product identity does not match the claimed device');
    }
    if (transport.owner_id !== context.ownerId) {
        throw new Error('Device event topology owner does not match device ownership');
    }
    const product = clients.catalog.getProduct(context.productId);
    if (!product || product.catalog_revision !== context.catalogRevision) {
        throw new Error('Published Product contract is unavailable');
    }
    const definition = validateCatalogEvent(deviceEvent, product);
    const document = buildDeviceEventDocument(
        deviceEvent,
        context,
        definition,
        transport,
    );

    try {
        await clients.mongoClient
            .db(config.MONGO_DB_NAME)
            .collection(config.MONGO_DEVICE_EVENTS_COLLECTION)
            .insertOne(document);
    } catch (error) {
        if (error?.code === 11000) return null;
        throw error;
    }

    const lastSequenceKey = `device-event:last_seq:${deviceId}`;
    const previousSequence = Number(await clients.redis.get(lastSequenceKey));
    if (Number.isFinite(previousSequence) && deviceEvent.seq <= previousSequence) {
        logger.warn(
            { device_id: deviceId, previous_seq: previousSequence, current_seq: deviceEvent.seq },
            'Out-of-order device event accepted by unique event identity',
        );
    }
    if (!Number.isFinite(previousSequence) || deviceEvent.seq > previousSequence) {
        await clients.redis.set(lastSequenceKey, String(deviceEvent.seq));
    }

    await clients.realtimePublisher.publishDeviceEvent(context.ownerId, deviceId, document);
    await recordActivity(
        clients,
        deviceId,
        context.ownerId,
        `device_event:${transport.mode}`,
        config,
        logger,
    );
    if (transport.mode === 'relay' && transport.hub_mac !== deviceId) {
        await recordActivity(
            clients,
            transport.hub_mac,
            context.ownerId,
            'relay_device_event',
            config,
            logger,
        );
    }
    return document;
}

module.exports = {
    assertNoSensitiveKeys,
    buildDeviceEventDocument,
    deviceEventSchema,
    ensureDeviceEventIndexes,
    processDeviceEvent,
    validateCatalogEvent,
};
