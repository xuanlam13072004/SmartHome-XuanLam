import { Pool } from 'pg';
import { env } from '../../config/env';
import pino from 'pino';

let pool: Pool | null = null;

export const initPostgres = async (logger: pino.Logger) => {
    pool = new Pool({
        user: env.POSTGRES_USER,
        password: env.POSTGRES_PASSWORD,
        host: env.POSTGRES_HOST,
        port: env.POSTGRES_PORT,
        database: env.POSTGRES_DB,
    });

    try {
        const client = await pool.connect();
        logger.info('✅ Connected to PostgreSQL database');
        client.release();
    } catch (err) {
        logger.error({ err }, '❌ Failed to connect to PostgreSQL database');
        throw err;
    }
};

export const getPgPool = (): Pool => {
    if (!pool) {
        throw new Error('PostgreSQL pool has not been initialized');
    }
    return pool;
};
