'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { compileCatalog, loadCatalogV2 } = require('../../shared/catalog-v2');
const { getCollectionPlan, THIRTY_DAYS_SECONDS, SEVEN_DAYS_SECONDS } = require('../mongodb/v2/collections');
const { digestCatalog } = require('../mongodb/v2/seed-catalog');

const sqlPath = path.resolve(__dirname, '../postgres/schema_v2.sql');
const sql = fs.readFileSync(sqlPath, 'utf8');

function sqlTableNames(source) {
    return [...source.matchAll(/CREATE TABLE public\.([a-z0-9_]+)/g)].map(match => match[1]);
}

function sqlPermissionScopes(source) {
    return new Set([...source.matchAll(/\('([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)',/g)].map(match => match[1]));
}

test('PostgreSQL V2 schema is clean-break additive source with no destructive statement', () => {
    assert.equal(/\b(DROP|TRUNCATE)\b/i.test(sql), false);
    assert.equal(sql.trimStart().startsWith('BEGIN;'), true);
    assert.equal(sql.trimEnd().endsWith('COMMIT;'), true);
});

test('PostgreSQL V2 contains all ownership, sharing, operation, credential and topology tables', () => {
    const tables = new Set(sqlTableNames(sql));
    for (const required of [
        'accounts',
        'user_sessions',
        'factory_devices',
        'device_networks',
        'device_metadata',
        'permission_scopes',
        'device_memberships',
        'device_membership_permissions',
        'device_invites',
        'device_invite_permissions',
        'device_policies',
        'device_policy_outbox',
        'device_operations',
        'device_operation_transitions',
        'operation_outbox',
        'device_resource_sessions',
        'device_credentials',
        'credential_jobs',
        'credential_outbox',
        'device_audit_logs',
        'device_shadow_outbox',
        'topology_outbox',
    ]) {
        assert.equal(tables.has(required), true, required);
    }
});

test('every permission required by an active Product operation/resource/credential exists in PostgreSQL', () => {
    const catalog = compileCatalog(loadCatalogV2());
    const databaseScopes = sqlPermissionScopes(sql);

    for (const product of catalog.products) {
        for (const permission of product.permissions) {
            assert.equal(databaseScopes.has(permission), true, `${product.product_id}: ${permission}`);
        }
    }
});

test('owner-only permissions and owner-membership invariants are enforced in database source', () => {
    for (const permission of ['credential.manage', 'safety.configure', 'device.share', 'device.unpair']) {
        assert.match(sql, new RegExp(`\\('${permission.replace('.', '\\.')}',[^\\n]+true, false\\)`));
    }
    assert.match(sql, /CREATE TRIGGER trg_device_membership_permission/);
    assert.match(sql, /CREATE CONSTRAINT TRIGGER trg_device_metadata_active_owner/);
    assert.match(sql, /CREATE CONSTRAINT TRIGGER trg_device_membership_active_owner/);
    assert.match(sql, /Owner membership must match device_metadata\.owner_id/);
    assert.match(sql, /Only the device owner may create an invite/);
    assert.match(sql, /Only the device owner may manage credentials/);
});

test('generic operation and audit JSON are protected from nested credential keys', () => {
    assert.match(sql, /CREATE FUNCTION public\.operation_input_has_sensitive_key/);
    assert.match(sql, /operation_input_has_sensitive_key\(item_value\)/);
    assert.match(sql, /CHECK \(NOT public\.operation_input_has_sensitive_key\(input\)\)/);
    assert.equal(sql.includes('material_ciphertext'), false);
    assert.equal(sql.includes('credential_public_key_pem text NOT NULL'), true);
    assert.match(sql, /payload \? 'encrypted_envelope'/);
});

test('MongoDB V2 collection and index plan is deterministic and complete', () => {
    const plan = getCollectionPlan();
    const names = plan.map(item => item.name);
    assert.equal(new Set(names).size, names.length);
    assert.deepEqual(names, [
        'catalog_releases',
        'capability_definitions',
        'product_definitions',
        'device_shadows',
        'device_telemetry',
        'device_events',
        'device_incidents',
        'active_operations',
        'telemetry_ingest_receipts',
    ]);

    for (const definition of plan) {
        const indexNames = definition.indexes.map(index => index.options.name);
        assert.equal(new Set(indexNames).size, indexNames.length, definition.name);
    }
});

test('telemetry uses time-series retention and a separate idempotency receipt collection', () => {
    const plan = getCollectionPlan();
    const telemetry = plan.find(item => item.name === 'device_telemetry');
    const receipts = plan.find(item => item.name === 'telemetry_ingest_receipts');

    assert.equal(telemetry.options.timeseries.timeField, 'observed_at');
    assert.equal(telemetry.options.timeseries.metaField, 'metadata');
    assert.equal(telemetry.options.expireAfterSeconds, THIRTY_DAYS_SECONDS);
    assert.equal(receipts.retentionSeconds, SEVEN_DAYS_SECONDS);
    assert.equal(receipts.indexes.some(index => index.options.unique === true), true);
    assert.equal(receipts.indexes.some(index => index.options.expireAfterSeconds === 0), true);
});

test('catalog release digest is stable and changes when catalog content changes', () => {
    const catalog = loadCatalogV2();
    const first = digestCatalog(catalog);
    const second = digestCatalog(JSON.parse(JSON.stringify(catalog)));
    const modified = JSON.parse(JSON.stringify(catalog));
    modified.catalog_revision += 1;

    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(first, second);
    assert.notEqual(first, digestCatalog(modified));
});

test('MongoDB V2 CLIs require an explicit initialization gate', () => {
    for (const relativePath of ['../mongodb/v2/apply-collections.js', '../mongodb/v2/seed-catalog.js', '../initialize_v2.js']) {
        const source = fs.readFileSync(path.resolve(__dirname, relativePath), 'utf8');
        assert.match(source, /ALLOW_V2_DATABASE_INITIALIZATION/);
    }
});

test('coordinated initializer enforces the target contract and is wired into Docker startup', () => {
    const initializer = fs.readFileSync(path.resolve(__dirname, '../initialize_v2.js'), 'utf8');
    const compose = fs.readFileSync(path.resolve(__dirname, '../../docker-compose.yml'), 'utf8');

    assert.match(initializer, /POSTGRES_SCHEMA_VERSION = 201/);
    assert.match(initializer, /PostgreSQL contains an incompatible schema/);
    assert.match(initializer, /MongoDB contains incompatible collections/);
    assert.match(initializer, /name\.startsWith\('system\.'\)/);
    assert.equal(compose.includes('initialize_v2.js'), true);
    assert.equal(compose.includes('db-initialize'), true);
});
