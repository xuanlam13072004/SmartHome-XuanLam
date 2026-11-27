import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { env } from '../../config/env';

/**
 * The factory side of a device (docs/architecture/mqtt-security.md, "API
 * xưởng"): its record in factory_devices (what the claim checks) and its MQTT
 * login in mqtt_accounts (what EMQX checks), written together. Retiring a
 * device removes both and the data the backend kept about it. The factory
 * sends hashes only; the device's secrets never travel.
 */

export interface FactoryDeviceInput {
    mac: string;
    product_id: string;
    catalog_revision: number;
    firmware_family: string;
    hardware_revision?: string | null;
    /** argon2 hash of the claim secret printed on the device's label. */
    secret_key_hash: string;
    credential_public_key_pem: string;
    /** hex(sha256(mqtt password || salt)), as EMQX checks it. */
    mqtt_password_hash: string;
    mqtt_salt: string;
}

export type CreateStatus = 'created' | 'exists' | 'conflict' | 'product_unknown';
export type RetireStatus = 'retired' | 'missing' | 'claimed';

/** hex(sha256(password || salt)): the MQTT password check EMQX does (salt_position = suffix). */
export function mqttPasswordHash(password: string, salt: string): string {
    return crypto.createHash('sha256').update(password + salt).digest('hex');
}

/** A new random MQTT password (32 bytes) and its hash, for one device. */
export function newMqttCredentials() {
    const password = crypto.randomBytes(32).toString('base64url');
    const salt = crypto.randomBytes(16).toString('hex');
    return { password, salt, hash: mqttPasswordHash(password, salt) };
}

/**
 * Registers devices made at the factory, all or nothing per call (at most 200).
 * Idempotent: a device sent again with the same data is 'exists'; a MAC that
 * belongs to a different device is 'conflict' and left untouched.
 */
export async function createFactoryDevices(app: FastifyInstance, devices: FactoryDeviceInput[]) {
    const results = new Map<string, CreateStatus>();
    const accepted: FactoryDeviceInput[] = [];
    for (const device of devices) {
        const product = app.catalog.getProduct(device.product_id);
        if (!product || product.catalog_revision !== device.catalog_revision) results.set(device.mac, 'product_unknown');
        else accepted.push(device);
    }
    if (accepted.length > 0) {
        const client = await app.pg.connect();
        try {
            await client.query('BEGIN');
            const column = <K extends keyof FactoryDeviceInput>(key: K) => accepted.map(device => device[key] ?? null);
            const inserted = new Set((await client.query(
                `INSERT INTO factory_devices
                     (mac, product_id, catalog_revision, firmware_family, hardware_revision,
                      secret_key_hash, credential_public_key_pem)
                 SELECT * FROM unnest($1::varchar[], $2::text[], $3::int[], $4::text[], $5::text[], $6::text[], $7::text[])
                 ON CONFLICT (mac) DO NOTHING
                 RETURNING mac`,
                [column('mac'), column('product_id'), column('catalog_revision'), column('firmware_family'),
                    column('hardware_revision'), column('secret_key_hash'), column('credential_public_key_pem')],
            )).rows.map(row => row.mac as string));
            const fresh = accepted.filter(device => inserted.has(device.mac));
            if (fresh.length > 0) {
                await client.query(
                    `INSERT INTO mqtt_accounts (username, kind, factory_mac, password_hash, salt)
                     SELECT mac, 'device', mac, password_hash, salt
                     FROM unnest($1::varchar[], $2::text[], $3::text[]) AS input(mac, password_hash, salt)`,
                    [fresh.map(device => device.mac), fresh.map(device => device.mqtt_password_hash), fresh.map(device => device.mqtt_salt)],
                );
            }
            fresh.forEach(device => results.set(device.mac, 'created'));

            const repeated = accepted.filter(device => !inserted.has(device.mac));
            if (repeated.length > 0) {
                const existing = new Map((await client.query(
                    `SELECT factory.mac, factory.product_id, factory.catalog_revision, factory.secret_key_hash,
                            factory.credential_public_key_pem, account.password_hash, account.salt
                     FROM factory_devices AS factory
                     LEFT JOIN mqtt_accounts AS account ON account.factory_mac = factory.mac
                     WHERE factory.mac = ANY($1::varchar[])`,
                    [repeated.map(device => device.mac)],
                )).rows.map(row => [row.mac as string, row]));
                for (const device of repeated) {
                    const row = existing.get(device.mac);
                    const same = row
                        && row.product_id === device.product_id
                        && Number(row.catalog_revision) === device.catalog_revision
                        && row.secret_key_hash === device.secret_key_hash
                        && row.credential_public_key_pem === device.credential_public_key_pem
                        && row.password_hash === device.mqtt_password_hash
                        && row.salt === device.mqtt_salt;
                    results.set(device.mac, same ? 'exists' : 'conflict');
                }
            }
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
    }
    return devices.map(device => ({ mac: device.mac, status: results.get(device.mac)! }));
}

/** Whether each device exists and whether someone has claimed it (at most 500). */
export async function factoryDeviceStatus(app: FastifyInstance, macs: string[]) {
    const rows = new Map((await app.pg.query(
        'SELECT mac, is_claimed FROM factory_devices WHERE mac = ANY($1::varchar[])',
        [macs],
    )).rows.map(row => [row.mac as string, row.is_claimed as boolean]));
    return macs.map(mac => ({ mac, exists: rows.has(mac), claimed: rows.get(mac) === true }));
}

/**
 * Retires unclaimed devices (at most 200): their factory record and MQTT login
 * go in one transaction, then their shadow, telemetry, events, incidents,
 * ingest receipts and pending operations. A device someone owns is never
 * touched ('claimed'): it must be unpaired by its owner first.
 */
export async function retireFactoryDevices(app: FastifyInstance, macs: string[]) {
    const results = new Map<string, RetireStatus>(macs.map(mac => [mac, 'missing']));
    let retired: string[] = [];
    const client = await app.pg.connect();
    try {
        await client.query('BEGIN');
        const rows = (await client.query(
            `SELECT factory.mac, factory.is_claimed
                    OR EXISTS (SELECT 1 FROM device_metadata AS device WHERE device.mac = factory.mac) AS in_use
             FROM factory_devices AS factory
             WHERE factory.mac = ANY($1::varchar[])
             FOR UPDATE OF factory`,
            [macs],
        )).rows as Array<{ mac: string; in_use: boolean }>;
        for (const row of rows) results.set(row.mac, row.in_use ? 'claimed' : 'retired');
        retired = rows.filter(row => !row.in_use).map(row => row.mac);
        if (retired.length > 0) {
            // mqtt_accounts rows go with their factory record (ON DELETE CASCADE).
            await client.query('DELETE FROM factory_devices WHERE mac = ANY($1::varchar[])', [retired]);
        }
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
    if (retired.length > 0) {
        const db = app.mongo.db;
        await Promise.all([
            db.collection<{ _id: string }>(env.MONGO_DEVICE_SHADOWS_COLLECTION).deleteMany({ _id: { $in: retired } }),
            db.collection(env.MONGO_DEVICE_TELEMETRY_COLLECTION).deleteMany({ 'metadata.device_id': { $in: retired } }),
            db.collection(env.MONGO_DEVICE_EVENTS_COLLECTION).deleteMany({ device_id: { $in: retired } }),
            db.collection(env.MONGO_DEVICE_INCIDENTS_COLLECTION).deleteMany({ device_id: { $in: retired } }),
            db.collection(env.MONGO_INGEST_RECEIPTS_COLLECTION).deleteMany({ device_id: { $in: retired } }),
            db.collection(env.MONGO_ACTIVE_OPERATIONS_COLLECTION).deleteMany({ device_id: { $in: retired } }),
        ]);
    }
    return macs.map(mac => ({ mac, status: results.get(mac)! }));
}

/**
 * A physical device's MQTT password (tools/factory.ts): a new one replaces the
 * old (rotation); the device must exist in factory_devices.
 */
export async function setDeviceMqttPassword(pg: Pick<Pool, 'query'>, mac: string) {
    const exists = await pg.query('SELECT 1 FROM factory_devices WHERE mac = $1', [mac]);
    if (exists.rows.length === 0) throw new Error(`No factory record for ${mac}`);
    const credentials = newMqttCredentials();
    await pg.query(
        `INSERT INTO mqtt_accounts (username, kind, factory_mac, password_hash, salt)
         VALUES ($1, 'device', $2, $3, $4)
         ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, salt = EXCLUDED.salt`,
        [mac, mac, credentials.hash, credentials.salt],
    );
    return credentials.password;
}

/** Removes a device's MQTT login (it can no longer connect); its factory record stays. */
export async function revokeDeviceMqttLogin(pg: Pick<Pool, 'query'>, mac: string): Promise<boolean> {
    const removed = await pg.query(`DELETE FROM mqtt_accounts WHERE username = $1 AND kind = 'device'`, [mac]);
    return (removed.rowCount ?? 0) > 0;
}
