# Current SmartHome architecture

This repository has one active contract: Product Catalog V2 and database schema
version 210 (baseline 203 + incremental migrations in
`database/postgres/migrations`). There is no V1 compatibility layer.

## Authority boundaries

- ESP32 firmware (or Device Simulator) executes physical behavior, local safety
  policy, offline authentication and owns reported state.
- API Gateway owns accounts, permissions, ownership, protected-resource
  authorization, credential delivery jobs and remote operation intent.
- PostgreSQL is the source of truth for relational identity, authorization,
  Hub–Node topology and durable workflows/outboxes.
- MongoDB stores the published catalog, shadows, telemetry, events, incidents
  and temporary runtime projections.
- Redis carries caches, topology leases/routes, durable-stream deliveries and
  realtime fan-out. Redis is never the source of truth.

## MQTT identity

Every MQTT client authenticates; anonymous access is disabled. Devices (real or
virtual) log in with username = MAC and a per-device factory password, and the
broker ACL limits each device to `smarthome/<its MAC>/...`. Details, roles and
provisioning: [mqtt-security.md](mqtt-security.md).

## Account center

Profile, login sessions, device sharing, notifications and activity history:
[account-center.md](account-center.md).

## Rooms

Personal rooms per account, device placement, live room summaries and quick
controls: [rooms.md](rooms.md).

## Scenes

Personal scenes ("Kịch bản"): ordered device operations run by the Gateway's
scene runner, with history and schedules; automations ("Tự động": device
state, event or time → scene and/or notification) and suggestions:
[scenes.md](scenes.md).

## Voice, assistant and plans

- Voice verification ("Giọng nói"): 1:1 check that a recording is the account
  owner's live voice — ECAPA-TDNN, per-profile RawNet2 anti-spoofing, AS-norm,
  temporary lock — in the Python `voice-service`, reached only by the Gateway:
  [voice.md](voice.md).
- Assistant ("Trợ lý"): general chat plus home control; Gemini only proposes
  commands through functions over short ids, the Gateway checks each one and
  runs it through the normal device/scene paths; spoken commands need the
  verified voice; monthly token allowance per plan: [assistant.md](assistant.md).
- Payments: VietQR transfers confirmed by the SePay webhook, by hand (CLI) or
  simulated in mock mode; a paid order extends the account's plan:
  [payments.md](payments.md).

## Security camera (proposal)

Camera Product, media profile, live/playback relay, recording and deletion
rules: [camera-contract.md](camera-contract.md) (draft, pending approval).

## Hub–Node

A network is identified by an opaque fingerprint under one owner. The first
claimed member has the highest election priority; later members receive
increasing join ranks. Backend elects exactly one active Hub per network and
publishes a monotonic topology epoch. Nodes normally relay through the active
Hub. When the Hub lease is unavailable, Nodes use direct MQTT fallback without
changing Product behavior, then return to relay after a valid newer assignment.
All downlink and ACK traffic is fenced by target, network, epoch and route.

Unpair releases the factory claim, removes the membership, elects the next Hub
when necessary and applies topology/shadow outboxes before returning. It also
purges device-scoped shadows, telemetry, events, incidents, active operations
and ingest receipts so a later owner cannot inherit the previous owner's data.
Simulator cleanup calls this same API path before deleting its generated
account and factory record.

## Remote operations

App requests a catalog-defined operation. Gateway validates membership,
permission, reauthentication, input and optional state version, commits the
operation plus outbox atomically, and MQTT Worker resolves the current route.
Only a device ACK or timeout makes the workflow terminal. An accepted operation
never fabricates reported state.

## Protected resources and credentials

Camera streams/snapshots use short-lived resource sessions. Backend authorizes
the viewer; the device produces the resource. Session access tokens are stored
only as hashes.

PIN/face/RFID/fingerprint material never enters generic operations, shadows,
telemetry, events or logs. Gateway hybrid-encrypts it with AES-256-GCM and wraps
the key using the device factory RSA public key. Only device firmware owns the
private key and can commit the credential to secure local storage. PostgreSQL
stores metadata and job status, never the material.
