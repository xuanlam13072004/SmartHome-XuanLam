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

The initializer accepts an already initialized database only when schema
version `201` and every required table/collection are present. Any old or
partial contract is rejected and must be cleared before restart.

Run source-contract checks with:

```powershell
node --test database/v2-tests/database-contract.test.js
node --test shared/catalog-v2/catalog-v2.test.js
```
