# SmartHome database contract

`postgres/schema_v2.sql` and `mongodb/v2/collections.js` are the only runtime
database definitions. Docker runs `initialize_v2.js` before dependent services.

PostgreSQL owns accounts, sessions, factory identity, ownership and sharing,
Hub–Node topology, policies, operations, protected-resource sessions,
credential metadata/jobs/outboxes and audit records. Credential material is
never stored there; the API delivers a hybrid-encrypted envelope that only the
target device can decrypt.

MongoDB owns the published Product Catalog, device shadows, telemetry, events,
incidents, active-operation projections and ingest receipts. Physical reported
state remains device-authoritative.

PostgreSQL = baseline `postgres/schema_v2.sql` (version `203`) followed by the
numbered, additive steps in `postgres/migrations/` (`204_rooms.sql`, …),
applied by `postgres/migrate.js`. A fresh database gets everything; an existing
one only the steps missing from `schema_migrations`, each in its own
transaction, so data is kept across upgrades. Databases older than the baseline
are rejected and must be cleared. New schema changes go into a new
`migrations/<next number>_<name>.sql` file; never edit an applied step.

Run source-contract checks with:

```powershell
node --test database/v2-tests/database-contract.test.js
node --test shared/catalog-v2/catalog-v2.test.js
```
