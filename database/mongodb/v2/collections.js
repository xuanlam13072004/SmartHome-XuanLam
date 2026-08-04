'use strict';

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;

const COLLECTIONS = [
    {
        name: 'catalog_releases',
        options: {
            validator: {
                $jsonSchema: {
                    bsonType: 'object',
                    required: ['_id', 'schema_version', 'catalog_revision', 'lifecycle', 'digest', 'created_at'],
                    properties: {
                        _id: { bsonType: 'string' },
                        schema_version: { enum: [2] },
                        catalog_revision: { bsonType: 'int', minimum: 1 },
                        lifecycle: { enum: ['draft', 'published', 'deprecated'] },
                        digest: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
                        created_at: { bsonType: 'date' },
                    },
                },
            },
            validationLevel: 'strict',
            validationAction: 'error',
        },
        indexes: [
            { key: { catalog_revision: 1 }, options: { unique: true, name: 'uq_catalog_release_revision' } },
            { key: { lifecycle: 1, catalog_revision: -1 }, options: { name: 'idx_catalog_release_lifecycle' } },
        ],
    },
    {
        name: 'capability_definitions',
        options: {
            validator: {
                $jsonSchema: {
                    bsonType: 'object',
                    required: ['_id', 'capability_id', 'revision', 'kind', 'properties', 'operations', 'events', 'resources', 'credentials'],
                    properties: {
                        _id: { bsonType: 'string' },
                        capability_id: { bsonType: 'string', pattern: '^[a-z][a-z0-9_]+$' },
                        revision: { bsonType: 'int', minimum: 1 },
                        kind: { bsonType: 'string' },
                        properties: { bsonType: 'array' },
                        operations: { bsonType: 'array' },
                        events: { bsonType: 'array' },
                        resources: { bsonType: 'array' },
                        credentials: { bsonType: 'array' },
                    },
                },
            },
            validationLevel: 'strict',
            validationAction: 'error',
        },
        indexes: [
            { key: { capability_id: 1, revision: 1 }, options: { unique: true, name: 'uq_capability_definition_revision' } },
        ],
    },
    {
        name: 'product_definitions',
        options: {
            validator: {
                $jsonSchema: {
                    bsonType: 'object',
                    required: ['_id', 'product_id', 'catalog_revision', 'lifecycle', 'capability_instances', 'local_policies'],
                    properties: {
                        _id: { bsonType: 'string' },
                        product_id: { bsonType: 'string', pattern: '^prod_[a-z0-9_]+$' },
                        catalog_revision: { bsonType: 'int', minimum: 1 },
                        lifecycle: { enum: ['draft', 'published', 'deprecated'] },
                        capability_instances: { bsonType: 'array' },
                        local_policies: { bsonType: 'array' },
                    },
                },
            },
            validationLevel: 'strict',
            validationAction: 'error',
        },
        indexes: [
            { key: { product_id: 1, catalog_revision: 1 }, options: { unique: true, name: 'uq_product_definition_revision' } },
            { key: { lifecycle: 1, product_id: 1, catalog_revision: -1 }, options: { name: 'idx_product_definition_lifecycle' } },
        ],
    },
    {
        name: 'device_shadows',
        options: {
            validator: {
                $jsonSchema: {
                    bsonType: 'object',
                    required: ['_id', 'owner_id', 'product_id', 'catalog_revision', 'state_version', 'instances', 'diagnostics', 'is_online', 'updated_at'],
                    properties: {
                        _id: { bsonType: 'string', pattern: '^([0-9A-F]{2}:){5}[0-9A-F]{2}$' },
                        owner_id: { bsonType: 'string' },
                        product_id: { bsonType: 'string', pattern: '^prod_[a-z0-9_]+$' },
                        catalog_revision: { bsonType: 'int', minimum: 1 },
                        state_version: { bsonType: ['int', 'long'], minimum: 0 },
                        instances: { bsonType: 'object' },
                        diagnostics: { bsonType: 'object' },
                        is_online: { bsonType: 'bool' },
                        last_seen: { bsonType: ['date', 'null'] },
                        updated_at: { bsonType: 'date' },
                    },
                },
            },
            validationLevel: 'strict',
            validationAction: 'error',
        },
        indexes: [
            { key: { owner_id: 1, updated_at: -1 }, options: { name: 'idx_device_shadows_owner' } },
            { key: { is_online: 1, last_seen: -1 }, options: { name: 'idx_device_shadows_presence' } },
            { key: { product_id: 1, catalog_revision: 1 }, options: { name: 'idx_device_shadows_product_revision' } },
        ],
    },
    {
        name: 'device_telemetry',
        options: {
            timeseries: {
                timeField: 'observed_at',
                metaField: 'metadata',
                granularity: 'seconds',
            },
            expireAfterSeconds: THIRTY_DAYS_SECONDS,
        },
        indexes: [
            { key: { 'metadata.device_id': 1, observed_at: -1 }, options: { name: 'idx_device_telemetry_device_time' } },
            { key: { 'metadata.product_id': 1, observed_at: -1 }, options: { name: 'idx_device_telemetry_product_time' } },
        ],
    },
    {
        name: 'device_events',
        options: {
            validator: {
                $jsonSchema: {
                    bsonType: 'object',
                    required: ['event_id', 'device_id', 'owner_id', 'product_id', 'catalog_revision', 'instance_id', 'type', 'severity', 'source', 'occurred_at', 'data'],
                    properties: {
                        event_id: { bsonType: 'string' },
                        device_id: { bsonType: 'string', pattern: '^([0-9A-F]{2}:){5}[0-9A-F]{2}$' },
                        owner_id: { bsonType: 'string' },
                        product_id: { bsonType: 'string', pattern: '^prod_[a-z0-9_]+$' },
                        catalog_revision: { bsonType: 'int', minimum: 1 },
                        instance_id: { bsonType: 'string' },
                        type: { bsonType: 'string' },
                        severity: { enum: ['info', 'warning', 'critical'] },
                        source: { bsonType: 'string' },
                        incident_id: { bsonType: ['string', 'null'] },
                        correlation_id: { bsonType: ['string', 'null'] },
                        occurred_at: { bsonType: 'date' },
                        data: { bsonType: 'object' },
                    },
                },
            },
            validationLevel: 'strict',
            validationAction: 'error',
        },
        indexes: [
            { key: { event_id: 1 }, options: { unique: true, name: 'uq_device_events_event_id' } },
            { key: { device_id: 1, occurred_at: -1 }, options: { name: 'idx_device_events_device_time' } },
            { key: { owner_id: 1, occurred_at: -1 }, options: { name: 'idx_device_events_owner_time' } },
            { key: { incident_id: 1, occurred_at: 1 }, options: { name: 'idx_device_events_incident', partialFilterExpression: { incident_id: { $type: 'string' } } } },
        ],
    },
    {
        name: 'device_incidents',
        options: {
            validator: {
                $jsonSchema: {
                    bsonType: 'object',
                    required: ['incident_id', 'device_id', 'owner_id', 'type', 'severity', 'status', 'started_at', 'causes', 'actions'],
                    properties: {
                        incident_id: { bsonType: 'string' },
                        device_id: { bsonType: 'string', pattern: '^([0-9A-F]{2}:){5}[0-9A-F]{2}$' },
                        owner_id: { bsonType: 'string' },
                        type: { bsonType: 'string' },
                        severity: { enum: ['warning', 'critical'] },
                        status: { enum: ['active', 'acknowledged', 'resolved'] },
                        started_at: { bsonType: 'date' },
                        acknowledged_at: { bsonType: ['date', 'null'] },
                        acknowledged_by: { bsonType: ['string', 'null'] },
                        resolved_at: { bsonType: ['date', 'null'] },
                        causes: { bsonType: 'array' },
                        actions: { bsonType: 'array' },
                    },
                },
            },
            validationLevel: 'strict',
            validationAction: 'error',
        },
        indexes: [
            { key: { incident_id: 1 }, options: { unique: true, name: 'uq_device_incidents_incident_id' } },
            { key: { device_id: 1, status: 1, started_at: -1 }, options: { name: 'idx_device_incidents_device_status' } },
            { key: { owner_id: 1, status: 1, started_at: -1 }, options: { name: 'idx_device_incidents_owner_status' } },
        ],
    },
    {
        name: 'active_operations',
        options: {
            validator: {
                $jsonSchema: {
                    bsonType: 'object',
                    required: ['_id', 'device_id', 'status', 'operation', 'expires_at', 'updated_at'],
                    properties: {
                        _id: { bsonType: 'string' },
                        device_id: { bsonType: 'string', pattern: '^([0-9A-F]{2}:){5}[0-9A-F]{2}$' },
                        status: { enum: ['accepted', 'queued', 'dispatched', 'executing'] },
                        operation: { bsonType: 'object' },
                        expires_at: { bsonType: 'date' },
                        updated_at: { bsonType: 'date' },
                    },
                },
            },
            validationLevel: 'strict',
            validationAction: 'error',
        },
        indexes: [
            { key: { device_id: 1, updated_at: -1 }, options: { name: 'idx_active_operations_device' } },
            { key: { expires_at: 1 }, options: { name: 'ttl_active_operations', expireAfterSeconds: 0 } },
        ],
    },
    {
        name: 'telemetry_ingest_receipts',
        options: {
            validator: {
                $jsonSchema: {
                    bsonType: 'object',
                    required: ['event_id', 'device_id', 'received_at', 'expires_at'],
                    properties: {
                        event_id: { bsonType: 'string' },
                        device_id: { bsonType: 'string', pattern: '^([0-9A-F]{2}:){5}[0-9A-F]{2}$' },
                        received_at: { bsonType: 'date' },
                        expires_at: { bsonType: 'date' },
                    },
                },
            },
            validationLevel: 'strict',
            validationAction: 'error',
        },
        indexes: [
            { key: { event_id: 1 }, options: { unique: true, name: 'uq_telemetry_ingest_receipt' } },
            { key: { expires_at: 1 }, options: { name: 'ttl_telemetry_ingest_receipts', expireAfterSeconds: 0 } },
        ],
        retentionSeconds: SEVEN_DAYS_SECONDS,
    },
];

function getCollectionPlan() {
    return structuredClone(COLLECTIONS);
}

module.exports = {
    COLLECTIONS,
    THIRTY_DAYS_SECONDS,
    SEVEN_DAYS_SECONDS,
    getCollectionPlan,
};
