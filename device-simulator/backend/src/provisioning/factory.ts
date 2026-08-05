import { getPgPool } from '../infrastructure/postgres/client';
import argon2 from 'argon2';
import crypto from 'node:crypto';
import { deterministicMac } from '../generation/deterministic';

export interface MockDeviceIdentity {
    mac: string;
    rawSecret: string;
    credentialPublicKeyPem: string;
    credentialPrivateKeyPem: string;
}

export const createMockDeviceIdentity = async (
    seed: string,
    scope: string,
): Promise<MockDeviceIdentity> => {
    const keyPair = await new Promise<{ publicKey: string; privateKey: string }>((resolve, reject) => {
        crypto.generateKeyPair('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        }, (error, publicKey, privateKey) => {
            if (error) reject(error);
            else resolve({ publicKey, privateKey });
        });
    });
    return {
        mac: deterministicMac(seed, scope),
        rawSecret: crypto.randomBytes(24).toString('hex'),
        credentialPublicKeyPem: keyPair.publicKey,
        credentialPrivateKeyPem: keyPair.privateKey,
    };
};

export const provisionMockDevice = async (
    product: { product_id: string; catalog_revision: number },
    identity: MockDeviceIdentity,
): Promise<void> => {
    const secretHash = await argon2.hash(identity.rawSecret);
    const pool = getPgPool();
    const query = `
        INSERT INTO factory_devices
            (mac, secret_key_hash, credential_public_key_pem, product_id, catalog_revision,
             firmware_family, hardware_revision, is_claimed)
        VALUES ($1, $2, $3, $4, $5, 'simulator_esp32', 'virtual-v2', false)
        ON CONFLICT (mac) DO NOTHING
        RETURNING mac
    `;

    const result = await pool.query(query, [
        identity.mac,
        secretHash,
        identity.credentialPublicKeyPem,
        product.product_id,
        product.catalog_revision,
    ]);
    if (result.rowCount === 1) return;

    const existing = await pool.query(
        `SELECT product_id, catalog_revision, secret_key_hash,
                credential_public_key_pem, is_claimed
         FROM factory_devices WHERE mac = $1`,
        [identity.mac],
    );
    const secretMatches = existing.rows.length === 1
        && await argon2.verify(existing.rows[0].secret_key_hash, identity.rawSecret).catch(() => false);
    if (
        existing.rows.length !== 1
        || existing.rows[0].product_id !== product.product_id
        || Number(existing.rows[0].catalog_revision) !== product.catalog_revision
        || existing.rows[0].credential_public_key_pem !== identity.credentialPublicKeyPem
        || !secretMatches
    ) {
        throw new Error(`Factory MAC collision detected for ${identity.mac}`);
    }
};
