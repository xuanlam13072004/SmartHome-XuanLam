'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { compileCatalog, loadCatalogV2 } = require('../../shared/catalog-v2');
const {
    assertNoSensitiveKeys,
    buildDeviceEventDocument,
    deviceEventSchema,
    validateCatalogEvent,
} = require('../src/services/deviceEventProcessor');
const { topicRegex } = require('../src/workers/mqttTopicUtils');

const product = compileCatalog(loadCatalogV2()).product_index.prod_entrance_controller;

const baseEvent = {
    schema: 'device.event.v2',
    event_id: 'AA:BB:CC:DD:EE:FF:event:1',
    device_id: 'aa:bb:cc:dd:ee:ff',
    product_id: 'prod_entrance_controller',
    catalog_revision: 5,
    seq: 1,
    instance_id: 'pin_auth',
    event_name: 'pin_access_granted',
    data: { credential_id: 'primary' },
    device_uptime_ms: 1000,
    transport: {
        mode: 'hub',
        network_id: '4b9a47f9-43a1-4d91-b9b7-a8e5768a48a2',
        topology_epoch: 1,
        hub_mac: 'AA:BB:CC:DD:EE:FF',
    },
};

test('device event envelope is hardware-friendly and normalizes identity', () => {
    const parsed = deviceEventSchema.parse(baseEvent);
    assert.equal(parsed.device_id, 'AA:BB:CC:DD:EE:FF');
    assert.equal(parsed.occurred_at, undefined);
    assert.equal(parsed.device_uptime_ms, 1000);
});

test('device events must be declared by the claimed Product contract', () => {
    const definition = validateCatalogEvent(baseEvent, product);
    assert.equal(definition.capability_id, 'pin_authentication');
    assert.equal(definition.retention, 'timeline');

    assert.throws(
        () => validateCatalogEvent({ ...baseEvent, event_name: 'raw_key_pressed' }, product),
        /not declared/,
    );
});

test('stored device event matches the strict MongoDB V2 document contract', () => {
    const parsed = deviceEventSchema.parse(baseEvent);
    const definition = validateCatalogEvent(parsed, product);
    const receivedAt = new Date('2026-08-14T00:00:00.000Z');
    const document = buildDeviceEventDocument(
        parsed,
        {
            ownerId: '00000000-0000-4000-8000-000000000001',
            productId: parsed.product_id,
            catalogRevision: parsed.catalog_revision,
        },
        definition,
        {
            ...parsed.transport,
            topic_origin: parsed.device_id,
        },
        receivedAt,
    );

    assert.equal(document.type, document.event_name);
    assert.equal(document.source, 'device');
    assert.equal(document.retention, 'timeline');
    assert.equal(document.received_at, receivedAt);
    assert.equal(document.occurred_at, receivedAt);
    assert.equal(document.device_time_trusted, false);
    assert.equal(document.transport.mqtt_origin, parsed.device_id);
});

test('device event time is trusted only inside the bounded clock-skew window', () => {
    const receivedAt = new Date('2026-08-14T12:00:00.000Z');
    const definition = validateCatalogEvent(baseEvent, product);
    const transport = {
        ...baseEvent.transport,
        topic_origin: 'AA:BB:CC:DD:EE:FF',
    };
    const trusted = buildDeviceEventDocument(
        deviceEventSchema.parse({
            ...baseEvent,
            occurred_at: '2026-08-14T11:59:30.000Z',
        }),
        {
            ownerId: '00000000-0000-4000-8000-000000000001',
            productId: baseEvent.product_id,
            catalogRevision: baseEvent.catalog_revision,
        },
        definition,
        transport,
        receivedAt,
    );
    assert.equal(trusted.device_time_trusted, true);
    assert.equal(trusted.occurred_at.toISOString(), '2026-08-14T11:59:30.000Z');

    const untrusted = buildDeviceEventDocument(
        deviceEventSchema.parse({
            ...baseEvent,
            occurred_at: '1970-01-01T00:00:00.000Z',
        }),
        {
            ownerId: '00000000-0000-4000-8000-000000000001',
            productId: baseEvent.product_id,
            catalogRevision: baseEvent.catalog_revision,
        },
        definition,
        transport,
        receivedAt,
    );
    assert.equal(untrusted.device_time_trusted, false);
    assert.equal(untrusted.occurred_at, receivedAt);
});

test('event transport rejects raw PIN and unknown keypad actions', () => {
    assert.throws(
        () => assertNoSensitiveKeys({ raw_pin: '123456' }),
        /forbidden/,
    );
    assert.throws(
        () => assertNoSensitiveKeys({ message: 'PIN 123456 rejected' }),
        /six-digit PIN/,
    );
    assert.throws(
        () => validateCatalogEvent({
            ...baseEvent,
            data: { credential_id: '123456' },
        }, product),
        /six-digit PIN|allowed enum/,
    );
    assert.throws(
        () => validateCatalogEvent({
            ...baseEvent,
            instance_id: 'keypad',
            event_name: 'keypad_action',
            data: { action: 'authentication_unknown' },
        }, product),
        /not in the allowed enum/,
    );
});

test('MQTT event wildcard matches only the event lane', () => {
    const matcher = topicRegex('smarthome/+/events');
    assert.equal(matcher.test('smarthome/AA:BB:CC:DD:EE:FF/events'), true);
    assert.equal(matcher.test('smarthome/AA:BB:CC:DD:EE:FF/telemetry'), false);
});
