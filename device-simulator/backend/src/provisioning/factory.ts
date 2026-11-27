import argon2 from 'argon2';
import crypto from 'node:crypto';
import { deterministicMac } from '../generation/deterministic';
import {
    apiGateway,
    type FactoryCreateStatus,
    type FactoryDeviceBody,
} from '../infrastructure/api-gateway/client';
import type { RequestOptions } from '../infrastructure/api-gateway/rate-limit-retry';

/**
 * The Simulator as a factory of virtual devices (docs/architecture/
 * mqtt-security.md, "API xưởng"). A device's identity is made once and kept
 * (encrypted) in the Simulator's registry: its MAC, the claim secret printed
 * on its label, its MQTT password and a credential key pair. The system only
 * receives hashes, through the factory API, and stores them itself.
 */

export interface MockDeviceIdentity {
    mac: string;
    /** Claim secret (on the label / QR code). */
    rawSecret: string;
    /** The device's own broker password; username = MAC. */
    mqttPassword: string;
    credentialPublicKeyPem: string;
    credentialPrivateKeyPem: string;
    /** What the factory API receives (public material, kept so a retried call is identical). */
    factory: FactoryHashes;
}

export interface FactoryHashes {
    secret_key_hash: string;
    mqtt_salt: string;
    mqtt_password_hash: string;
}

export interface FactoryProduct {
    product_id: string;
    catalog_revision: number;
    firmware_compatibility?: { family?: string };
}

/**
 * The claim secret is 24 random bytes, so a cheap argon2id is as safe as an
 * expensive one (nobody can guess it); the cost only matters for passwords
 * people choose. Cheap here also makes the backend's check at claim time
 * cheap, which keeps creating thousands of devices from eating the CPU.
 */
const SECRET_HASH_OPTIONS = { type: argon2.argon2id, memoryCost: 4096, timeCost: 2, parallelism: 1 } as const;

/**
 * Virtual devices share a few RSA key pairs: a 2048-bit key takes ~0.1 s of
 * CPU to make, and the backend only uses the public key to encrypt
 * credentials for the device. A physical device has its own.
 */
const KEY_POOL_SIZE = 8;
let keyPool: Promise<Array<{ publicKey: string; privateKey: string }>> | null = null;

const makeKeyPair = () => new Promise<{ publicKey: string; privateKey: string }>((resolve, reject) => {
    crypto.generateKeyPair('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    }, (error, publicKey, privateKey) => (error ? reject(error) : resolve({ publicKey, privateKey })));
});

const keyPairs = () => {
    keyPool ??= Promise.all(Array.from({ length: KEY_POOL_SIZE }, makeKeyPair));
    keyPool.catch(() => { keyPool = null; });
    return keyPool;
};

/** hex(sha256(password || salt)): the check EMQX does on each login. */
export const mqttPasswordHash = (password: string, salt: string): string =>
    crypto.createHash('sha256').update(password + salt).digest('hex');

export const createMockDeviceIdentity = async (seed: string, scope: string): Promise<MockDeviceIdentity> => {
    const pool = await keyPairs();
    const key = pool[crypto.createHash('sha256').update(`${seed}:${scope}`).digest().readUInt32BE(0) % pool.length];
    const rawSecret = crypto.randomBytes(24).toString('hex');
    const mqttPassword = crypto.randomBytes(32).toString('base64url');
    const mqttSalt = crypto.randomBytes(16).toString('hex');
    return {
        mac: deterministicMac(seed, scope),
        rawSecret,
        mqttPassword,
        credentialPublicKeyPem: key.publicKey,
        credentialPrivateKeyPem: key.privateKey,
        factory: {
            secret_key_hash: await argon2.hash(rawSecret, SECRET_HASH_OPTIONS),
            mqtt_salt: mqttSalt,
            mqtt_password_hash: mqttPasswordHash(mqttPassword, mqttSalt),
        },
    };
};

export const factoryBody = (
    product: FactoryProduct,
    device: { mac: string; credentialPublicKeyPem: string; factory: FactoryHashes },
): FactoryDeviceBody => ({
    mac: device.mac,
    product_id: product.product_id,
    catalog_revision: product.catalog_revision,
    // The catalog's firmware family; a generic one for products without firmware yet.
    firmware_family: product.firmware_compatibility?.family || 'simulator_generic',
    hardware_revision: 'virtual-v2',
    secret_key_hash: device.factory.secret_key_hash,
    credential_public_key_pem: device.credentialPublicKeyPem,
    mqtt_password_hash: device.factory.mqtt_password_hash,
    mqtt_salt: device.factory.mqtt_salt,
});

const FACTORY_BATCH = 200;

/**
 * Registers devices with the system's factory API, up to 200 per call.
 * 'created' and 'exists' (a retried call) both mean the device is ready to be
 * claimed; 'conflict' means its MAC already belongs to another device.
 */
export const provisionMockDevices = async (
    bodies: FactoryDeviceBody[],
    options: RequestOptions = {},
): Promise<Map<string, FactoryCreateStatus>> => {
    const statuses = new Map<string, FactoryCreateStatus>();
    for (let index = 0; index < bodies.length; index += FACTORY_BATCH) {
        const results = await apiGateway.createFactoryDevices(bodies.slice(index, index + FACTORY_BATCH), options);
        for (const result of results) statuses.set(result.mac, result.status);
    }
    return statuses;
};

/** Retires unclaimed devices (factory record, MQTT login and the system's data about them), 200 per call. */
export const retireMockDevices = async (macs: string[], options: RequestOptions = {}) => {
    const statuses = new Map<string, 'retired' | 'missing' | 'claimed'>();
    for (let index = 0; index < macs.length; index += FACTORY_BATCH) {
        const results = await apiGateway.retireFactoryDevices(macs.slice(index, index + FACTORY_BATCH), options);
        for (const result of results) statuses.set(result.mac, result.status);
    }
    return statuses;
};
