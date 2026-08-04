# Database V2 boundaries

## PostgreSQL: authoritative transactional data

```text
accounts
  ├─ user_sessions
  ├─ device_metadata (owner_id)
  │    ├─ device_memberships ── device_membership_permissions
  │    ├─ device_invites ───── device_invite_permissions
  │    ├─ device_operations ── operation_outbox / transitions
  │    ├─ device_credentials ─ credential_jobs
  │    ├─ device_policies ──── device_policy_outbox
  │    └─ device_audit_logs
  └─ device_networks ───────── topology_outbox

factory_devices ── device_metadata
```

`device_metadata.owner_id` owns the physical device and its topology. Shared
accounts exist only in `device_memberships`; they never create or own a second
network for the same device.

Permission scopes are normalized instead of stored as an unchecked JSON list.
Database triggers prevent owner-only permissions from being delegated and ensure
that only the owner can invite members or manage credentials.

## MongoDB: catalog and high-volume runtime documents

| Collection | Responsibility |
| --- | --- |
| `catalog_releases` | Atomic catalog revision identity and digest |
| `capability_definitions` | Immutable capability revisions |
| `product_definitions` | Product revisions and lifecycle |
| `device_shadows` | Latest namespaced reported/desired/diagnostic state |
| `device_telemetry` | 30-day time-series measurements |
| `device_events` | Idempotent device and physical-input events |
| `device_incidents` | Safety/access incident lifecycle |
| `active_operations` | Recoverable mirror of in-flight PostgreSQL operations |
| `telemetry_ingest_receipts` | Seven-day idempotency receipts for time-series ingestion |

The time-series collection intentionally has no unique event index. Deduplication
uses the regular receipt collection because MongoDB time-series collections do
not support the same unique-index behavior.

## Secret handling

- Factory provisioning stores `secret_key_hash`, not a raw secret.
- Generic operation, outbox, policy and audit JSON reject sensitive key names,
  recursively.
- PIN credentials may store a verifier digest only.
- Biometric templates require ciphertext plus an encryption-key version.
- Raw PIN, face template, embedding or fingerprint template never belongs in
  telemetry, events, operations or audit metadata.

## Clean-break safety

`schema_v2.sql` contains no deletion statement and expects an empty database.
The coordinated initializer refuses non-empty PostgreSQL or MongoDB targets and
requires two explicit environment gates. Docker Compose still points to V1; the
V2 initializer remains disconnected until the application services are ready.
