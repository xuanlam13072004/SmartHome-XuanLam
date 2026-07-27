import { getPgPool } from '../infrastructure/postgres/client';
import argon2 from 'argon2';
import crypto from 'node:crypto';
import { deterministicMac } from '../generation/deterministic';

export interface MockDeviceIdentity {
    mac: string;
    rawSecret: string;
}

export const createMockDeviceIdentity = (
    seed: string,
    scope: string,
): MockDeviceIdentity => ({
    mac: deterministicMac(seed, scope),
    rawSecret: crypto.randomBytes(24).toString('hex'),
});

export const provisionMockDevice = async (
    productId: string,
    identity: MockDeviceIdentity,
): Promise<void> => {
    const secretHash = await argon2.hash(identity.rawSecret);
    const pool = getPgPool();
    const query = `
        INSERT INTO factory_devices (mac, secret_key, product_id, is_claimed)
        VALUES ($1, $2, $3, false)
        ON CONFLICT (mac) DO NOTHING
        RETURNING mac
    `;

    const result = await pool.query(query, [identity.mac, secretHash, productId]);
    if (result.rowCount === 1) return;

    const existing = await pool.query(
        'SELECT product_id, secret_key, is_claimed FROM factory_devices WHERE mac = $1',
        [identity.mac],
    );
    const secretMatches = existing.rows.length === 1
        && await argon2.verify(existing.rows[0].secret_key, identity.rawSecret).catch(() => false);
    if (
        existing.rows.length !== 1
        || existing.rows[0].product_id !== productId
        || !secretMatches
    ) {
        throw new Error(`Factory MAC collision detected for ${identity.mac}`);
    }
};
