import crypto from 'node:crypto';
import { Client, Pool } from 'pg';
// @ts-ignore - plain JS module shared with the Docker initializer
import { applyPostgresSchema } from '../../../database/postgres/migrate';

/**
 * Integration tests run against a real PostgreSQL when TEST_PG_URL points at a
 * server the tests may create databases on, for example
 *   TEST_PG_URL=postgres://postgres:<password>@127.0.0.1:5433/postgres
 * Each test file gets its own database built like production (baseline +
 * upgrade steps, database/postgres/migrate.js), dropped after.
 */
export const TEST_PG_URL = process.env.TEST_PG_URL || '';
export const skipWithoutDatabase = TEST_PG_URL ? false : 'TEST_PG_URL is not set';

/** A MongoDB-compatible server for notification tests, e.g. mongodb://127.0.0.1:27017. */
export const TEST_MONGO_URL = process.env.TEST_MONGO_URL || '';
export const skipWithoutMongo = TEST_PG_URL && TEST_MONGO_URL ? false : 'TEST_PG_URL or TEST_MONGO_URL is not set';

export interface TestDatabase {
    pool: Pool;
    drop: () => Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
    const name = `gw_test_${crypto.randomBytes(6).toString('hex')}`;
    const admin = new Client({ connectionString: TEST_PG_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();

    const url = new URL(TEST_PG_URL);
    url.pathname = `/${name}`;
    const pool = new Pool({ connectionString: url.toString(), max: 5 });
    const client = await pool.connect();
    try {
        await applyPostgresSchema(client, { fresh: true });
    } finally {
        client.release();
    }

    return {
        pool,
        drop: async () => {
            await pool.end();
            const cleanup = new Client({ connectionString: TEST_PG_URL });
            await cleanup.connect();
            await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
            await cleanup.end();
        },
    };
}
