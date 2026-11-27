import './setup-env';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import { MongoClient } from 'mongodb';
import { env } from '../src/config/env';
import deviceRoutes from '../src/modules/device/routes';
import factoryRoutes from '../src/modules/factory/routes';
import { mqttPasswordHash, revokeDeviceMqttLogin, setDeviceMqttPassword } from '../src/modules/factory/service';
import { measureIngestLatency } from '../src/modules/admin/load';
import { createTestDatabase, skipWithoutMongo, TEST_MONGO_URL, TestDatabase } from './helpers/testDatabase';
import { buildTestApp, signUp } from './helpers/testApp';

/** API xưởng (docs/architecture/mqtt-security.md) and the MQTT logins it writes. */

const KEY = 'factory-key-for-tests-0123456789abcdef';
let counter = 0;
/** The published revision of the product used here (read from the real catalog). */
let revision = 1;

/** One device as a factory would send it, with the secrets it keeps for itself. */
async function made(overrides: Record<string, unknown> = {}) {
    counter += 1;
    const mac = `AA:BB:CC:10:${String(Math.floor(counter / 256)).padStart(2, '0')}:${(counter % 256).toString(16).toUpperCase().padStart(2, '0')}`;
    const secret = crypto.randomBytes(24).toString('hex');
    const mqttPassword = crypto.randomBytes(32).toString('base64url');
    const salt = crypto.randomBytes(16).toString('hex');
    const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256', publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    return {
        secret,
        mqttPassword,
        body: {
            mac,
            product_id: 'prod_hazard_mitigation',
            catalog_revision: revision,
            firmware_family: 'hazard_controller',
            hardware_revision: 'virtual-v2',
            secret_key_hash: await argon2.hash(secret, { memoryCost: 4096, timeCost: 2, parallelism: 1 }),
            credential_public_key_pem: publicKey as unknown as string,
            mqtt_password_hash: mqttPasswordHash(mqttPassword, salt),
            mqtt_salt: salt,
            ...overrides,
        },
    };
}

test('the MQTT password hash is what EMQX checks: sha256(password || salt) in hex', () => {
    assert.equal(mqttPasswordHash('secret', 'abc'), crypto.createHash('sha256').update('secretabc').digest('hex'));
});

test('ingest latency: device clock to database, p50/p95 of the last samples', () => {
    const at = (offset: number) => new Date(1_800_000_000_000 + offset);
    assert.equal(measureIngestLatency([]), null);
    assert.deepEqual(measureIngestLatency([
        { observed_at: at(0), ingested_at: at(40) },
        { observed_at: at(0), ingested_at: at(10) },
        { observed_at: at(0), ingested_at: at(20) },
        { observed_at: at(50), ingested_at: at(0) }, // a clock ahead counts as 0, never negative
        { observed_at: at(0) },
    ]), { samples: 4, p50_ms: 20, p95_ms: 40, max_ms: 40 });
});

test('factory API', { skip: skipWithoutMongo }, async (t) => {
    let db: TestDatabase;
    let mongo: MongoClient;
    let app: FastifyInstance;
    const previousKey = env.FACTORY_API_KEY;
    const call = (method: 'POST', url: string, payload: unknown, headers: Record<string, string> = { 'x-factory-key': KEY }) =>
        app.inject({ method, url, payload: payload as object, headers });

    t.before(async () => {
        env.FACTORY_API_KEY = KEY;
        db = await createTestDatabase();
        mongo = await new MongoClient(TEST_MONGO_URL).connect();
        app = await buildTestApp(db.pool, [deviceRoutes, factoryRoutes], { client: mongo, db: mongo.db(`factory_${Date.now()}`) });
        revision = app.catalog.getProduct('prod_hazard_mitigation')!.catalog_revision;
    });
    t.after(async () => {
        env.FACTORY_API_KEY = previousKey;
        await app?.mongo.db.dropDatabase().catch(() => undefined);
        await app?.close();
        await mongo?.close();
        await db?.drop();
    });

    await t.test('only with the key, never through the tunnel; no key configured = no API', async () => {
        const device = await made();
        assert.equal((await call('POST', '/factory/devices', { devices: [device.body] }, {})).statusCode, 401);
        assert.equal((await call('POST', '/factory/devices', { devices: [device.body] }, { 'x-factory-key': 'wrong' })).statusCode, 401);
        assert.equal((await call('POST', '/factory/devices', { devices: [device.body] }, { 'x-factory-key': KEY, 'cf-ray': 'x' })).statusCode, 403);
        env.FACTORY_API_KEY = '';
        assert.equal((await call('POST', '/factory/devices', { devices: [device.body] })).statusCode, 404);
        env.FACTORY_API_KEY = KEY;
    });

    await t.test('registers devices with their MQTT login in one transaction; idempotent; conflicts untouched', async () => {
        const first = await made();
        const second = await made();
        const created = await call('POST', '/factory/devices', { devices: [first.body, second.body] });
        assert.equal(created.statusCode, 200, created.body);
        assert.deepEqual(created.json().devices, [{ mac: first.body.mac, status: 'created' }, { mac: second.body.mac, status: 'created' }]);
        const accounts = (await db.pool.query(
            `SELECT username, kind, factory_mac, password_hash, salt FROM mqtt_accounts WHERE kind = 'device' AND username = ANY($1) ORDER BY username`,
            [[first.body.mac, second.body.mac]],
        )).rows;
        assert.equal(accounts.length, 2);
        assert.equal(accounts.find(row => row.username === first.body.mac).password_hash,
            mqttPasswordHash(first.mqttPassword, first.body.mqtt_salt), 'the broker can check the password the device holds');

        const again = await call('POST', '/factory/devices', { devices: [first.body] });
        assert.deepEqual(again.json().devices, [{ mac: first.body.mac, status: 'exists' }], 'a retried batch changes nothing');
        const impostor = await made({ mac: first.body.mac });
        const conflict = await call('POST', '/factory/devices', { devices: [impostor.body] });
        assert.deepEqual(conflict.json().devices, [{ mac: first.body.mac, status: 'conflict' }]);
        const kept = (await db.pool.query('SELECT secret_key_hash FROM factory_devices WHERE mac = $1', [first.body.mac])).rows[0];
        assert.equal(kept.secret_key_hash, first.body.secret_key_hash, 'the first device keeps its record');

        const unknown = await made({ product_id: 'prod_not_real' });
        assert.deepEqual((await call('POST', '/factory/devices', { devices: [unknown.body] })).json().devices,
            [{ mac: unknown.body.mac, status: 'product_unknown' }]);
    });

    await t.test('refuses malformed batches', async () => {
        const device = await made();
        const bad = async (body: unknown) => (await call('POST', '/factory/devices', body)).statusCode;
        assert.equal(await bad({ devices: [] }), 400);
        assert.equal(await bad({ devices: [device.body, device.body] }), 400, 'a MAC twice');
        assert.equal(await bad({ devices: [{ ...device.body, mac: 'aa:bb:cc:dd:ee:ff' }] }), 400);
        assert.equal(await bad({ devices: [{ ...device.body, mqtt_password_hash: 'x' }] }), 400);
        assert.equal(await bad({ devices: [{ ...device.body, secret_key_hash: 'plain-secret' }] }), 400, 'only a hash, never the secret');
        assert.equal(await bad({ devices: [{ ...device.body, mqtt_password: 'leak' }] }), 400, 'unknown fields refused');
        assert.equal(await bad({ devices: Array.from({ length: 201 }, (_, index) => ({ ...device.body, mac: `AA:BB:CC:20:00:${index.toString(16).toUpperCase().padStart(2, '0')}` })) }), 400);
    });

    await t.test('full life: made, claimed by a user, unpaired, retired with its data and its login', async () => {
        const device = await made();
        await call('POST', '/factory/devices', { devices: [device.body] });
        const owner = await signUp(app);
        const claim = await app.inject({
            method: 'POST', url: '/devices/claim', headers: owner.headers,
            payload: { mac: device.body.mac, secret_key: device.secret },
        });
        assert.equal(claim.statusCode, 200, claim.body);
        assert.deepEqual((await call('POST', '/factory/devices/status', { macs: [device.body.mac, 'AA:BB:CC:FF:FF:FF'] })).json().devices, [
            { mac: device.body.mac, exists: true, claimed: true },
            { mac: 'AA:BB:CC:FF:FF:FF', exists: false, claimed: false },
        ]);
        assert.deepEqual((await call('POST', '/factory/devices/retire', { macs: [device.body.mac] })).json().devices,
            [{ mac: device.body.mac, status: 'claimed' }], 'a device someone owns is never retired');

        const unpair = await app.inject({ method: 'DELETE', url: `/devices/${device.body.mac}`, headers: owner.headers });
        assert.equal(unpair.statusCode, 200, unpair.body);
        await app.mongo.db.collection('device_telemetry').insertOne({ metadata: { device_id: device.body.mac }, observed_at: new Date() });
        await app.mongo.db.collection('device_shadows').insertOne({ _id: device.body.mac } as never);
        const other = await made();
        await call('POST', '/factory/devices', { devices: [other.body] });
        await app.mongo.db.collection('device_shadows').insertOne({ _id: other.body.mac } as never);

        const retired = await call('POST', '/factory/devices/retire', { macs: [device.body.mac, 'AA:BB:CC:FF:FF:FE'] });
        assert.deepEqual(retired.json().devices, [
            { mac: device.body.mac, status: 'retired' },
            { mac: 'AA:BB:CC:FF:FF:FE', status: 'missing' },
        ]);
        const left = await db.pool.query(
            `SELECT (SELECT count(*)::int FROM factory_devices WHERE mac = $1) AS factory,
                    (SELECT count(*)::int FROM mqtt_accounts WHERE username = $1) AS login`,
            [device.body.mac],
        );
        assert.deepEqual(left.rows[0], { factory: 0, login: 0 });
        assert.equal(await app.mongo.db.collection('device_telemetry').countDocuments({ 'metadata.device_id': device.body.mac }), 0);
        assert.equal(await app.mongo.db.collection('device_shadows').countDocuments({ _id: device.body.mac } as never), 0);
        assert.equal(await app.mongo.db.collection('device_shadows').countDocuments({ _id: other.body.mac } as never), 1, 'other devices untouched');
    });

    await t.test('physical devices: the CLI sets, rotates and revokes an MQTT login', async () => {
        const device = await made();
        await call('POST', '/factory/devices', { devices: [device.body] });
        const first = await setDeviceMqttPassword(db.pool, device.body.mac);
        const second = await setDeviceMqttPassword(db.pool, device.body.mac);
        assert.notEqual(first, second);
        const row = (await db.pool.query('SELECT password_hash, salt FROM mqtt_accounts WHERE username = $1', [device.body.mac])).rows[0];
        assert.equal(row.password_hash, mqttPasswordHash(second, row.salt), 'only the newest password works');
        assert.equal(await revokeDeviceMqttLogin(db.pool, device.body.mac), true);
        assert.equal(await revokeDeviceMqttLogin(db.pool, device.body.mac), false);
        await assert.rejects(setDeviceMqttPassword(db.pool, 'AA:BB:CC:EE:EE:EE'), /No factory record/);
    });
});
