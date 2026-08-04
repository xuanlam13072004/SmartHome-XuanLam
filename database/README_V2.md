# Database V2

Database V2 source is intentionally not connected to `docker-compose.yml` yet.
The current V1 migration container must continue using `database/postgres/schema.sql`
until Gateway, MQTT Worker, Simulator and Flutter are ready for the clean break.

## PostgreSQL

`postgres/schema_v2.sql` defines a fresh schema. It contains no `DROP` or
`TRUNCATE` statement and must only be applied to an empty cutover database.

Important guarantees:

- device ownership remains separate from shared memberships;
- exactly one active owner membership must match `device_metadata.owner_id`;
- owner-only scopes cannot be invited or delegated;
- Product IDs and catalog revisions are stored on factory and claimed devices;
- operation inputs, outbox payloads and audit metadata reject nested credential keys;
- PIN material may be stored only as a digest/verifier, never ciphertext or plaintext;
- topology owner/network foreign keys and active-hub membership remain enforced.

## MongoDB

`mongodb/v2/collections.js` defines collection validators, indexes and retention.
`apply-collections.js` and `seed-catalog.js` refuse to run unless
`ALLOW_V2_DATABASE_INITIALIZATION=true` is explicitly set.

Catalog seeding is revision-based and does not delete documents. Catalog
definitions are currently `draft`; publishing requires a separate explicit gate.

## Verify

```powershell
node --test database/v2-tests/database-contract.test.js
```

An actual PostgreSQL execution test should use a disposable database and delete
that database immediately after the test. It must never target `smarthome`.

`initialize_v2.js` coordinates a fresh PostgreSQL schema and MongoDB catalog seed,
but requires both `ALLOW_V2_DATABASE_INITIALIZATION=true` and
`V2_EXPECT_EMPTY_DATABASES=true`. It refuses any target that already contains
tables or collections and is not wired into Docker Compose yet.
