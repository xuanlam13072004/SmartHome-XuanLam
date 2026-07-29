const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const workspaceRoot = path.resolve(__dirname, '../..');
const schemaSql = fs.readFileSync(
    path.join(workspaceRoot, 'database/postgres/schema.sql'),
    'utf8'
);
const migrationV6Sql = fs.readFileSync(
    path.join(workspaceRoot, 'database/postgres/migration_v6.sql'),
    'utf8'
);

const baseConfig = {
    host: process.env.PG_HOST || '127.0.0.1',
    port: Number.parseInt(process.env.PG_PORT || '5432', 10),
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || 'postgres',
};
const adminDatabase = process.env.PG_ADMIN_DATABASE || 'postgres';
const runSuffix = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
const freshDatabase = `smarthome_topology_fresh_${runSuffix}`;
const upgradeDatabase = `smarthome_topology_upgrade_${runSuffix}`;

function quoteIdentifier(value) {
    if (!/^[a-z0-9_]+$/.test(value)) {
        throw new Error(`Unsafe PostgreSQL identifier: ${value}`);
    }
    return `"${value}"`;
}

async function connect(database) {
    const client = new Client({ ...baseConfig, database });
    await client.connect();
    return client;
}

async function createDatabase(adminClient, database) {
    await adminClient.query(`CREATE DATABASE ${quoteIdentifier(database)}`);
}

async function dropDatabase(adminClient, database) {
    await adminClient.query(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`
    );
}

async function expectConstraintFailure(client, label, operation) {
    const savepoint = `sp_${crypto.randomBytes(4).toString('hex')}`;
    await client.query(`SAVEPOINT ${savepoint}`);

    try {
        await operation();
        await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await client.query('SET CONSTRAINTS ALL DEFERRED');
        return;
    }

    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    throw new Error(`Expected constraint failure was not raised: ${label}`);
}

async function verifyRequiredObjects(client) {
    const tableResult = await client.query(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name = ANY($1::text[])`,
        [['device_networks', 'device_metadata', 'topology_outbox']]
    );
    const tables = new Set(tableResult.rows.map((row) => row.table_name));
    for (const table of ['device_networks', 'device_metadata', 'topology_outbox']) {
        if (!tables.has(table)) {
            throw new Error(`Required topology table is missing: ${table}`);
        }
    }

    const columnResult = await client.query(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'device_metadata'
           AND column_name = ANY($1::text[])`,
        [['network_id', 'join_rank']]
    );
    const columns = new Set(columnResult.rows.map((row) => row.column_name));
    if (!columns.has('network_id') || !columns.has('join_rank')) {
        throw new Error('device_metadata topology columns are incomplete');
    }
}

async function verifyTopologyInvariants(client) {
    const ownerA = '00000000-0000-4000-8000-000000000001';
    const ownerB = '00000000-0000-4000-8000-000000000002';
    const networkA = '10000000-0000-4000-8000-000000000001';
    const networkB = '10000000-0000-4000-8000-000000000002';
    const deviceA = '20000000-0000-4000-8000-000000000001';
    const deviceB = '20000000-0000-4000-8000-000000000002';

    await client.query('BEGIN');
    try {
        await client.query(
            `INSERT INTO accounts (id, username, email, password_hash, full_name)
             VALUES
                ($1, 'topology-owner-a', 'topology-a@example.test', 'hash', 'Owner A'),
                ($2, 'topology-owner-b', 'topology-b@example.test', 'hash', 'Owner B')`,
            [ownerA, ownerB]
        );
        await client.query(
            `INSERT INTO device_networks
                (id, owner_id, network_fingerprint, topology_state)
             VALUES
                ($1, $2, $3, 'electing'),
                ($4, $5, $6, 'electing')`,
            [
                networkA,
                ownerA,
                'a'.repeat(64),
                networkB,
                ownerB,
                'b'.repeat(64),
            ]
        );
        await client.query(
            `INSERT INTO device_metadata
                (id, owner_id, mac, name, product_id, network_id, join_rank)
             VALUES
                ($1, $2, '02:00:00:00:00:01', 'Topology Device A', 'test_product', $3, 1),
                ($4, $5, '02:00:00:00:00:02', 'Topology Device B', 'test_product', $6, 1)`,
            [deviceA, ownerA, networkA, deviceB, ownerB, networkB]
        );
        await client.query(
            `UPDATE device_networks
             SET active_hub_device_id = $1,
                 topology_epoch = 1,
                 next_join_rank = 2,
                 topology_state = 'stable'
             WHERE id = $2`,
            [deviceA, networkA]
        );
        await client.query('SET CONSTRAINTS ALL IMMEDIATE');
        await client.query('SET CONSTRAINTS ALL DEFERRED');

        await expectConstraintFailure(
            client,
            'one network fingerprint per owner',
            () => client.query(
                `INSERT INTO device_networks
                    (owner_id, network_fingerprint, topology_state)
                 VALUES ($1, $2, 'electing')`,
                [ownerA, 'a'.repeat(64)]
            )
        );
        await expectConstraintFailure(
            client,
            'network membership cannot cross owners',
            () => client.query(
                `INSERT INTO device_metadata
                    (owner_id, mac, name, product_id, network_id, join_rank)
                 VALUES ($1, '02:00:00:00:00:03', 'Cross-owner Device', 'test_product', $2, 2)`,
                [ownerB, networkA]
            )
        );
        await expectConstraintFailure(
            client,
            'join rank is unique inside a network',
            () => client.query(
                `INSERT INTO device_metadata
                    (owner_id, mac, name, product_id, network_id, join_rank)
                 VALUES ($1, '02:00:00:00:00:04', 'Duplicate Rank Device', 'test_product', $2, 1)`,
                [ownerA, networkA]
            )
        );
        await expectConstraintFailure(
            client,
            'network membership and join rank must be assigned together',
            () => client.query(
                `INSERT INTO device_metadata
                    (owner_id, mac, name, product_id, network_id)
                 VALUES ($1, '02:00:00:00:00:05', 'Incomplete Membership', 'test_product', $2)`,
                [ownerA, networkA]
            )
        );
        await expectConstraintFailure(
            client,
            'active Hub must belong to its own network',
            () => client.query(
                `UPDATE device_networks
                 SET active_hub_device_id = $1
                 WHERE id = $2`,
                [deviceB, networkA]
            )
        );
        await expectConstraintFailure(
            client,
            'stable network must have an active Hub',
            () => client.query(
                `UPDATE device_networks
                 SET active_hub_device_id = NULL
                 WHERE id = $1`,
                [networkA]
            )
        );

        await client.query(
            `INSERT INTO topology_outbox
                (network_id, topology_epoch, reason, payload)
             VALUES ($1, 1, 'network_created', '{"hubChanged":true}'::jsonb)`,
            [networkA]
        );
        await expectConstraintFailure(
            client,
            'one topology event per network epoch',
            () => client.query(
                `INSERT INTO topology_outbox
                    (network_id, topology_epoch, reason, payload)
                 VALUES ($1, 1, 'duplicate_epoch', '{}'::jsonb)`,
                [networkA]
            )
        );
        await expectConstraintFailure(
            client,
            'topology outbox payload must be a JSON object',
            () => client.query(
                `INSERT INTO topology_outbox
                    (network_id, topology_epoch, reason, payload)
                 VALUES ($1, 2, 'bad_payload', '[]'::jsonb)`,
                [networkA]
            )
        );

        const deleteSavepoint = 'sp_owner_delete';
        await client.query(`SAVEPOINT ${deleteSavepoint}`);
        await client.query('DELETE FROM accounts WHERE id = $1', [ownerA]);
        await client.query('SET CONSTRAINTS ALL IMMEDIATE');
        const cascadeResult = await client.query(
            `SELECT
                (SELECT count(*)::int FROM device_networks WHERE owner_id = $1) AS networks,
                (SELECT count(*)::int FROM device_metadata WHERE owner_id = $1) AS devices,
                (SELECT count(*)::int
                 FROM topology_outbox
                 WHERE network_id = $2) AS events`,
            [ownerA, networkA]
        );
        if (
            cascadeResult.rows[0].networks !== 0
            || cascadeResult.rows[0].devices !== 0
            || cascadeResult.rows[0].events !== 0
        ) {
            throw new Error('Account deletion did not cascade through topology data');
        }
        await client.query(`ROLLBACK TO SAVEPOINT ${deleteSavepoint}`);
        await client.query('SET CONSTRAINTS ALL DEFERRED');

        await client.query('ROLLBACK');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    }
}

async function verifyFreshSchema() {
    const client = await connect(freshDatabase);
    try {
        await client.query(schemaSql);
        // A fresh deployment subsequently runs registered migrations as well.
        // Running V6 twice proves that this path remains safe and repeatable.
        await client.query(migrationV6Sql);
        await client.query(migrationV6Sql);
        await verifyRequiredObjects(client);
        await verifyTopologyInvariants(client);
    } finally {
        await client.end();
    }
}

async function verifyUpgradeFromLegacySchema() {
    const client = await connect(upgradeDatabase);
    try {
        await client.query(`
            CREATE FUNCTION public.set_updated_at() RETURNS trigger
                LANGUAGE plpgsql
                AS $$
            BEGIN
                NEW.updated_at = NOW();
                RETURN NEW;
            END;
            $$;

            CREATE TABLE public.accounts (
                id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
                username text NOT NULL,
                email text NOT NULL,
                password_hash text NOT NULL,
                full_name text NOT NULL,
                created_at timestamp with time zone DEFAULT now() NOT NULL,
                updated_at timestamp with time zone DEFAULT now() NOT NULL
            );

            CREATE TABLE public.device_metadata (
                id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
                owner_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
                mac character varying(17) NOT NULL UNIQUE,
                name text NOT NULL,
                product_id text NOT NULL,
                gateway_id text,
                is_active boolean DEFAULT true,
                created_at timestamp with time zone DEFAULT now(),
                updated_at timestamp with time zone DEFAULT now()
            );

            INSERT INTO public.accounts
                (id, username, email, password_hash, full_name)
            VALUES
                ('30000000-0000-4000-8000-000000000001',
                 'legacy-owner',
                 'legacy-owner@example.test',
                 'hash',
                 'Legacy Owner');

            INSERT INTO public.device_metadata
                (id, owner_id, mac, name, product_id)
            VALUES
                ('40000000-0000-4000-8000-000000000001',
                 '30000000-0000-4000-8000-000000000001',
                 '02:00:00:00:10:01',
                 'Legacy Device',
                 'legacy_product');
        `);

        await client.query(migrationV6Sql);
        await client.query(migrationV6Sql);
        await verifyRequiredObjects(client);

        const legacyResult = await client.query(
            `SELECT network_id, join_rank
             FROM device_metadata
             WHERE id = '40000000-0000-4000-8000-000000000001'`
        );
        if (legacyResult.rowCount !== 1) {
            throw new Error('Legacy device was lost during migration V6');
        }
        if (
            legacyResult.rows[0].network_id !== null
            || legacyResult.rows[0].join_rank !== null
        ) {
            throw new Error('Migration V6 assigned legacy topology without network evidence');
        }

        await verifyTopologyInvariants(client);
    } finally {
        await client.end();
    }
}

async function main() {
    const adminClient = await connect(adminDatabase);
    let freshCreated = false;
    let upgradeCreated = false;

    try {
        await createDatabase(adminClient, freshDatabase);
        freshCreated = true;
        await createDatabase(adminClient, upgradeDatabase);
        upgradeCreated = true;

        await verifyFreshSchema();
        console.log('PASS: fresh schema topology verification');

        await verifyUpgradeFromLegacySchema();
        console.log('PASS: legacy schema migration verification');
    } finally {
        const cleanupErrors = [];
        if (freshCreated) {
            try {
                await dropDatabase(adminClient, freshDatabase);
            } catch (error) {
                cleanupErrors.push(error);
            }
        }
        if (upgradeCreated) {
            try {
                await dropDatabase(adminClient, upgradeDatabase);
            } catch (error) {
                cleanupErrors.push(error);
            }
        }
        await adminClient.end();
        if (cleanupErrors.length > 0) {
            throw new AggregateError(
                cleanupErrors,
                'Failed to remove one or more temporary topology databases'
            );
        }
        console.log('CLEAN: temporary topology databases removed');
    }
}

main().catch((error) => {
    console.error('Topology schema verification failed:', error);
    process.exitCode = 1;
});
