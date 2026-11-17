import crypto from 'node:crypto';
import type { Pool } from 'pg';

function randomMac(): string {
    return Array.from(crypto.randomBytes(6), byte => byte.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

/** A claimed device owned by `ownerId` (factory row, metadata and owner membership). */
export async function createOwnedDevice(
    pool: Pool,
    ownerId: string,
    options: { name?: string; productId?: string; catalogRevision?: number } = {},
): Promise<{ id: string; mac: string; name: string }> {
    const mac = randomMac();
    const name = options.name ?? `Thiết bị ${mac.slice(-5)}`;
    const productId = options.productId ?? 'prod_security_camera';
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            `INSERT INTO factory_devices
                (mac, secret_key_hash, credential_public_key_pem, product_id, firmware_family, is_claimed, claimed_at)
             VALUES ($1, 'hash', 'pem', $2, 'test_family', true, NOW())`,
            [mac, productId],
        );
        const device = await client.query(
            `INSERT INTO device_metadata (owner_id, mac, name, product_id, catalog_revision)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [ownerId, mac, name, productId, options.catalogRevision ?? 1],
        );
        await client.query(
            `INSERT INTO device_memberships (device_id, account_id, role, granted_by)
             VALUES ($1, $2, 'owner', $2)`,
            [device.rows[0].id, ownerId],
        );
        await client.query('COMMIT');
        return { id: device.rows[0].id, mac, name };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

/** Adds an active member directly (bypassing invitations) for tests of other features. */
export async function addMember(
    pool: Pool,
    device: { id: string },
    ownerId: string,
    accountId: string,
    role: 'controller' | 'viewer' = 'viewer',
    permissions: string[] = ['device.view'],
): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            `INSERT INTO device_memberships (device_id, account_id, role, granted_by)
             VALUES ($1, $2, $3, $4)`,
            [device.id, accountId, role, ownerId],
        );
        for (const scope of permissions) {
            await client.query(
                `INSERT INTO device_membership_permissions (device_id, account_id, permission_scope, granted_by)
                 VALUES ($1, $2, $3, $4)`,
                [device.id, accountId, scope, ownerId],
            );
        }
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}
