import { getPgPool } from '../infrastructure/postgres/client';
import argon2 from 'argon2';
import crypto from 'crypto';

/**
 * Generates a mock device in the PostgreSQL factory_devices table.
 * @param productId The product ID to provision.
 * @returns Object containing the plain text secret key and the generated MAC address.
 */
export const provisionMockDevice = async (productId: string): Promise<{ mac: string; rawSecret: string }> => {
    // Generate a Locally Administered MAC Address starting with 02:
    const randomHex = () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0').toUpperCase();
    const mac = `02:${randomHex()}:${randomHex()}:${randomHex()}:${randomHex()}:${randomHex()}`;
    
    // Generate raw secret key
    const rawSecret = crypto.randomBytes(16).toString('hex');
    
    // Hash secret key with Argon2
    const secretHash = await argon2.hash(rawSecret);
    
    const pool = getPgPool();
    const query = `
        INSERT INTO factory_devices (mac, secret_key, product_id, is_claimed)
        VALUES ($1, $2, $3, false)
    `;
    
    await pool.query(query, [mac, secretHash, productId]);
    
    return { mac, rawSecret };
};
