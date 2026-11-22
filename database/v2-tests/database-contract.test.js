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
    return new Set([...source.matchAll(/\('([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)',/g)].map(match => match[1]));
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
        'account_preferences',
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
    for (const permission of ['credential.manage', 'safety.configure', 'device.share', 'device.unpair', 'camera.recording.manage']) {
        assert.match(sql, new RegExp(`\\('${permission.replaceAll('.', '\\.')}',[^\\n]+true, false\\)`));
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

test('device event collection matches the MQTT event document contract', () => {
    const events = getCollectionPlan().find(item => item.name === 'device_events');
    const schema = events.options.validator.$jsonSchema;

    for (const field of [
        'capability_id',
        'event_name',
        'retention',
        'seq',
        'received_at',
        'device_time_trusted',
        'transport',
    ]) {
        assert.equal(schema.required.includes(field), true, field);
        assert.ok(schema.properties[field], field);
    }
    assert.equal(schema.properties.device_uptime_ms.bsonType.includes('double'), true);
    const timeline = events.indexes.find(
        index => index.options.name === 'device_event_device_timeline',
    );
    assert.deepEqual(timeline?.key, { device_id: 1, received_at: -1, _id: -1 });
    assert.equal(
        events.indexes.some(index => index.options.name === 'device_event_identity_unique'
            && index.options.unique === true),
        true,
    );
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

    assert.match(initializer, /POSTGRES_SCHEMA_VERSION = LATEST_SCHEMA_VERSION/);
    assert.match(initializer, /applyPostgresSchema\(client, \{ fresh \}\)/);
    assert.match(initializer, /PostgreSQL contains an incompatible schema/);
    assert.match(initializer, /MongoDB contains incompatible collections/);
    assert.match(initializer, /name\.startsWith\('system\.'\)/);
    assert.equal(compose.includes('initialize_v2.js'), true);
    assert.equal(compose.includes('db-initialize'), true);
});

test('PostgreSQL upgrade steps are numbered after the baseline, additive and transaction-free', () => {
    const { BASELINE_VERSION, LATEST_SCHEMA_VERSION, listMigrations } = require('../postgres/migrate');
    assert.equal(BASELINE_VERSION, 203);
    assert.match(sql, /VALUES \(203, 'schema_v2_account_center'\)/);
    const migrations = listMigrations();
    assert.ok(migrations.length >= 1);
    assert.equal(LATEST_SCHEMA_VERSION, migrations.at(-1).version);
    for (const migration of migrations) {
        const source = fs.readFileSync(migration.file, 'utf8');
        assert.equal(/\b(DROP|TRUNCATE)\b/i.test(source), false, `${migration.name} must be additive`);
        assert.equal(/^\s*(BEGIN|COMMIT)\s*;/im.test(source), false, `${migration.name} runs inside the runner's transaction`);
    }
    const rooms = fs.readFileSync(migrations.find(item => item.name === 'rooms').file, 'utf8');
    assert.match(rooms, /CREATE TABLE public\.rooms/);
    assert.match(rooms, /ON DELETE SET NULL \(room_id\)/);
    const scenes = fs.readFileSync(migrations.find(item => item.name === 'scenes').file, 'utf8');
    assert.match(scenes, /CREATE TABLE public\.scene_runs/);
    // One run in progress per scene, and steps never carry secrets.
    assert.match(scenes, /CREATE UNIQUE INDEX uq_scene_runs_one_running/);
    assert.match(scenes, /operation_input_has_sensitive_key\(input\)/);
    const schedules = fs.readFileSync(migrations.find(item => item.name === 'scene_schedules').file, 'utf8');
    // Next occurrence is computed by PostgreSQL in the schedule's own time zone.
    assert.match(schedules, /CREATE FUNCTION public\.scene_schedule_next_run/);
    assert.match(schedules, /REFERENCES public\.scenes \(id, account_id\) ON DELETE CASCADE/);
    const automations = fs.readFileSync(migrations.find(item => item.name === 'automations').file, 'utf8');
    assert.match(automations, /CREATE TABLE public\.automations/);
    assert.match(automations, /CREATE TABLE public\.account_notifications/);
    // Deleting a scene leaves its automations without one; a removed device takes them.
    assert.match(automations, /ON DELETE SET NULL \(scene_id\)/);
    assert.match(automations, /trigger_device_id uuid REFERENCES public\.device_metadata\(id\) ON DELETE CASCADE/);
    const voice = fs.readFileSync(migrations.find(item => item.name === 'voice_profiles').file, 'utf8');
    // Biometric data goes with the account; embeddings have a fixed size.
    assert.match(voice, /account_id uuid PRIMARY KEY REFERENCES public\.accounts\(id\) ON DELETE CASCADE/);
    assert.match(voice, /octet_length\(embedding\) = 768/);
    const assistant = fs.readFileSync(migrations.find(item => item.name === 'assistant').file, 'utf8');
    // Plans are data; a paid plan always has an end.
    assert.match(assistant, /INSERT INTO public\.assistant_plans/);
    assert.match(assistant, /expires_at timestamp with time zone NOT NULL/);
    const payments = fs.readFileSync(migrations.find(item => item.name === 'payments').file, 'utf8');
    // A retried webhook can never pay twice; amounts come from the server.
    assert.match(payments, /UNIQUE \(provider, provider_ref\)/);
    assert.match(payments, /code text NOT NULL UNIQUE/);
});
