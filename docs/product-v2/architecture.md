# Product Catalog V2 architecture

## Status

Product Catalog V2 is additive and `draft`. It is not connected to the running
Gateway, MQTT Worker, Simulator or Flutter application yet. The existing V1
runtime remains active. Catalog review does not authorize a database cutover.

## Ownership boundaries

| Concern | Source of truth |
| --- | --- |
| Product behavior, physical state and safety interlocks | Device firmware; Simulator mirrors it for testing |
| Accounts, device ownership, authorization and official topology | PostgreSQL |
| Device shadow, telemetry, events and incidents | MongoDB read model/history |
| Topology/presence/route cache | Redis |
| Draft Product/capability definitions | Versioned JSON in this repository |

Whether a published Catalog release also needs a MongoDB read model will be
decided during the database design phase. It is not a requirement for Product
normalization.

## Runtime contract

```text
Product Definition
  -> capability instance
       -> reported / desired / diagnostic properties
       -> operations
       -> events
       -> resources
       -> credentials
  -> local policies
  -> behavior profile
```

Properties compile to unique paths such as:

```text
instances.main_lock.reported.lock_state
instances.main_lock.desired.target_lock_state
instances.roof_motor.reported.current_position
diagnostics.system.wifi_rssi
```

This prevents the flat-state collision that V1 has when multiple instances use
names such as `power`, `temperature` or `state`.

`reported` is authoritative only after it is emitted by firmware. `desired` is
at most a pending remote intent/configuration request; backend must never copy a
desired value into reported state before device acknowledgement and telemetry.

## Operations

An operation is a business action, not a hardware command. Firmware maps
`unlock`, `set_position` or `water_for_duration` to GPIO, PWM and motor-driver
details. Every operation declares:

- exact input schema;
- required permission;
- risk and confirmation policy;
- timeout and idempotency;
- expected state/event/resource effect;
- local safety constraints.

Firmware is the execution authority for every physical operation. Gateway
validation determines whether an intent may be sent, not whether the physical
action succeeded. Operation effects are expectations used for ACK/completion
and reconciliation; they are not server-side state mutations.

Unknown input fields must be rejected when the Gateway V2 validator is added.

## Credentials

PIN and biometric material are not operation inputs. They use a separate
credential service and job lifecycle. Credential material is write-only,
non-delegable and restricted to `credential.manage`. Future persistence must
store only a verifier or encrypted template plus non-sensitive metadata; raw
material must not appear in operation history, events or logs.

## Resources

Camera video and snapshots use short-lived resource sessions. URLs and session
tokens are not device state. Losing `camera.view`, unpairing a device or expiry
must revoke the session.

## Events and incidents

Physical inputs and one-time occurrences are events, never sticky state. Safety
events may share an incident ID so that alarm start, acknowledgement, mitigation
and resolution form one auditable timeline.

## Future sharing semantics and topology

Sharing is an access relationship, not ownership transfer. The claiming account
remains owner; memberships grant scoped access. Membership changes must not alter
`device_networks`, `join_rank` or hub election. Owner-only permissions include
credential management, sharing and unpairing.

This section reserves permission semantics only. It does not introduce sharing
tables, memberships or invite APIs in the Product-normalization phase. Network
identity is independent of account identity; the final database model will be
reviewed separately.

## Planned hardware

An instance marked `planned` remains visible for design review but is excluded
from compiled runtime state, operations, events and resources. The kitchen load
cutoff currently uses this state until the relay and feedback hardware are
confirmed.

## Review and cutover gate

Database design begins only after the four Product contracts and core
architecture are approved. Runtime/database cleanup is allowed only after all
of the following exist:

1. PostgreSQL/MongoDB V2 schema and seeds.
2. Gateway authorization, operation, credential and resource APIs.
3. MQTT telemetry/event/operation/ACK V2.
4. Simulator behavior profiles for all four Products.
5. Flutter V2 Product screens.
6. Passing contract, security, topology and end-to-end tests.

Only then may the exact database bind mounts under `E:\smarthome_data` be
validated, stopped, cleaned and initialized with V2 data.
