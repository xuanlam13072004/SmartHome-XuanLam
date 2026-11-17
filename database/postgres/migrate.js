'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * PostgreSQL schema = baseline `schema_v2.sql` (version 203) followed by the
 * numbered, additive steps in `migrations/` (`204_rooms.sql`, …). A fresh
 * database gets the baseline and every step; an existing one only the steps it
 * has not recorded in `schema_migrations`, so data is kept across upgrades.
 * Each step runs in its own transaction together with its version row.
 */
const BASELINE_VERSION = 203;
const SCHEMA_FILE = path.join(__dirname, 'schema_v2.sql');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const MIGRATION_FILE = /^(\d{3,})_([a-z0-9_]+)\.sql$/;
// Serialises concurrent initializers on the same database.
const MIGRATION_LOCK_KEY = 2_031_204;

function listMigrations() {
    if (!fs.existsSync(MIGRATIONS_DIR)) return [];
    const migrations = fs.readdirSync(MIGRATIONS_DIR)
        .map(file => {
            const match = MIGRATION_FILE.exec(file);
            if (!match) throw new Error(`Unexpected file in migrations/: ${file}`);
            return { version: Number(match[1]), name: match[2], file: path.join(MIGRATIONS_DIR, file) };
        })
        .sort((a, b) => a.version - b.version);
    let previous = BASELINE_VERSION;
    for (const migration of migrations) {
        if (migration.version !== previous + 1) {
            throw new Error(`Migration ${migration.version} must follow ${previous} without gaps`);
        }
        previous = migration.version;
    }
    return migrations;
}

const LATEST_SCHEMA_VERSION = listMigrations().at(-1)?.version ?? BASELINE_VERSION;

/**
 * Brings the database to LATEST_SCHEMA_VERSION. `fresh` installs the baseline
 * first. Refuses databases older than the baseline (they need a clean start).
 */
async function applyPostgresSchema(client, { fresh }) {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
        if (fresh) await client.query(fs.readFileSync(SCHEMA_FILE, 'utf8'));

        const recorded = await client.query('SELECT version FROM public.schema_migrations');
        const applied = new Set(recorded.rows.map(row => Number(row.version)));
        if (!applied.has(BASELINE_VERSION)) {
            throw new Error(
                `PostgreSQL schema predates version ${BASELINE_VERSION}. `
                + 'Clear the configured PostgreSQL data directory and initialize again.',
            );
        }

        const newlyApplied = [];
        for (const migration of listMigrations()) {
            if (applied.has(migration.version)) continue;
            await client.query('BEGIN');
            try {
                await client.query(fs.readFileSync(migration.file, 'utf8'));
                await client.query(
                    'INSERT INTO public.schema_migrations (version, name) VALUES ($1, $2)',
                    [migration.version, migration.name],
                );
                await client.query('COMMIT');
            } catch (error) {
                await client.query('ROLLBACK');
                throw new Error(`Migration ${migration.version}_${migration.name} failed: ${error.message}`);
            }
            newlyApplied.push(migration.version);
        }
        return { schemaVersion: LATEST_SCHEMA_VERSION, newlyApplied };
    } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
}

module.exports = {
    BASELINE_VERSION,
    LATEST_SCHEMA_VERSION,
    applyPostgresSchema,
    listMigrations,
};
