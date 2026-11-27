# MQTT authentication and authorization contract

Status: implemented for the Docker stack: EMQX 5.8.9 (Apache-2.0, the last
open-source 5.8 release) with logins stored in PostgreSQL. TLS is not enabled
yet; see "Not covered yet".

## Principles

- Every MQTT connection is authenticated. Anonymous access is disabled.
- A physical device and a virtual device use the same identity model, topics
  and ACL. The broker, MQTT Worker, API Gateway and Flutter cannot tell them
  apart.
- A device can publish only its own uplink topics and subscribe only its own
  downlink topics. It cannot read or write another device's topics.
- A device's broker login is made at the factory together with the device.
  Claim, unpair and ownership remain in PostgreSQL and do not change it.
- Logins are rows of a table: adding a device adds one row, retiring it
  deletes one. Nothing is rewritten when devices come and go, whatever their
  number (the Mosquitto Dynamic Security file it replaces was rewritten whole
  on every change: ~150 ms per change at 30,000 devices).

## Identities

| Identity | MQTT username | Kind (`mqtt_accounts.kind`) | Who holds the password |
|---|---|---|---|
| Device (real or virtual) | Device MAC, upper case, `AA:BB:CC:DD:EE:FF` | `device` | Device only: firmware NVS `factory/mqttPassword`; the Simulator's registry, encrypted |
| MQTT Worker | `mqtt-worker-service` | `service` | Root `.env` → `MQTT_WORKER_PASSWORD` |

The EMQX dashboard (`admin`, http://localhost:18083, this computer only) is
not an MQTT identity. Its first password is `EMQX_DASHBOARD_PASSWORD`.

The device MQTT password is a random 256-bit secret generated per device at
the factory. It is separate from the claim `secret_key` printed on the QR
label, so knowing the claim secret does not allow impersonating the device on
the broker. The MQTT client id should equal the username (MAC).

## Where logins are stored

Table `public.mqtt_accounts` (migration `215_mqtt_accounts.sql`):

| Column | Meaning |
|---|---|
| `username` | MAC for a device, a service name otherwise |
| `kind` | `device` or `service` |
| `factory_mac` | the device's `factory_devices.mac` (`ON DELETE CASCADE`: retiring the factory record removes the login) |
| `password_hash`, `salt` | `hex(sha256(password ‖ salt))`, 16-byte random salt; the password itself is never stored |

EMQX reads it through the PostgreSQL role `emqx_auth`, which may only `SELECT`
the columns `username, password_hash, salt` of this one table
(`database/initialize_v2.js`, run by `db-initialize` with
`EMQX_AUTH_DB_PASSWORD`). Query: `SELECT password_hash, salt FROM mqtt_accounts
WHERE username = ${username}`, a prepared statement; hash `sha256`, salt as
suffix. `db-initialize` also writes the `mqtt-worker-service` row from
`MQTT_WORKER_PASSWORD` (unchanged when the password did not change).

A password is 32 random bytes and the salt random per row, so plain SHA-256
is enough: nobody can guess such a password, and the broker checks thousands
of logins per second without spending the CPU a slow hash (bcrypt, argon2)
would take on every reconnect.

## Topic ACL

`emqx/acl.conf`; `${username}` is replaced by the connecting username.

Devices (every other username):

| Direction | Topic |
|---|---|
| publish | `smarthome/${username}/telemetry`, `smarthome/${username}/events`, `smarthome/${username}/ack`, `smarthome/${username}/status`, `smarthome/${username}/topology/ack` |
| subscribe | `smarthome/${username}/control`, `smarthome/${username}/hub/control`, `smarthome/${username}/topology` |

`mqtt-worker-service`: publish and subscribe `smarthome/#`.

Everything else is denied (`no_match = deny`, last rule `{deny, all}`). A
forbidden publish is dropped and a forbidden subscription refused; the
connection stays open (`deny_action = ignore`).

A Hub publishes relayed Node messages on its own uplink topics with a
`transport` envelope, so no cross-device ACL is needed. Relay Nodes receive
their topology from the Hub's assignment (the member list), not from the
broker; Nodes that are connected to the broker (Hub, direct, direct fallback)
read their own retained `smarthome/<mac>/topology`.

## API xưởng (factory API)

How devices made outside the backend get their factory record and their
login: `api-gateway/src/modules/factory`. Used by the Device Simulator for its
virtual devices; a real production line would use the same calls.

- Enabled only when `FACTORY_API_KEY` (root `.env`, 32+ characters) is set;
  404 otherwise. Every call carries `X-Factory-Key`; 20 wrong keys per minute
  and per address are refused for a minute. Calls arriving through Cloudflare
  Tunnel are refused (403 `FACTORY_INTERNAL_ONLY`): the factory API is for the
  LAN only.
- `POST /factory/devices` — up to 200 devices; for each: MAC, Product and
  revision, firmware family, hardware revision, the argon2 hash of the claim
  secret, the credential public key, the MQTT password hash and salt. Never a
  secret. One transaction writes `factory_devices` and `mqtt_accounts`. Per
  device: `created`, `exists` (sent again with the same data: a retried call
  is harmless), `conflict` (the MAC belongs to another device; nothing
  changed) or `product_unknown`.
- `POST /factory/devices/status` — up to 500 MACs: `exists`, `claimed`.
- `POST /factory/devices/retire` — up to 200 MACs. A device somebody owns is
  never touched (`claimed`): its owner unpairs it first. Otherwise its factory
  record and login go in one transaction (`retired`), then the data the
  backend kept about it (shadow, telemetry, events, incidents, ingest
  receipts, pending operations); `missing` when it did not exist.

Unpair does not revoke broker access: the device still exists and keeps
reporting; MQTT Worker drops data from devices that are not claimed.

## Physical devices

The device needs a `factory_devices` record first. Then, on the system's
computer:

```powershell
docker compose exec api-gateway node dist/tools/factory.js mqtt-password AA:BB:CC:DD:EE:FF
```

prints a new password once (write it into NVS, namespace `factory`, key
`mqttPassword`); running it again rotates it. `mqtt-revoke` removes the login:
the device can no longer log in. A session already open is not cut at once; it
ends at the device's next reconnect.

## Operations

- Root `.env` (Git-ignored, template `.env.example`): `MQTT_WORKER_PASSWORD`,
  `EMQX_AUTH_DB_PASSWORD`, `EMQX_DASHBOARD_PASSWORD`, `EMQX_NODE_COOKIE`,
  `FACTORY_API_KEY`. Compose passes them as environment variables; none is
  written in `emqx/emqx.conf`.
- Settings: `emqx/emqx.conf` and `emqx/acl.conf`, mounted read-only. Settings
  in files and environment variables win over changes made in the dashboard.
- Broker state (retained messages, dashboard changes) is in the Docker volume
  `emqx_data`; logins are in PostgreSQL. `scripts/backup.ps1` saves both.
- Port 1883 is open to the LAN (physical devices, a Simulator on a second
  computer); `MQTT_PUBLISH_HOST=127.0.0.1` closes it to this computer.
- Prometheus (`--profile monitoring`) reads EMQX at
  `emqx:18083/api/v5/prometheus/stats` (connections, messages, logins
  accepted and refused).

## Not covered yet

- TLS on the MQTT listener (credentials currently travel in clear text on the
  LAN). Required before devices leave the lab.
- Per-device certificates (mTLS); can replace passwords later without
  changing topics or ACLs.
- Cutting an open session when a login is revoked (needs the EMQX management
  API); today it ends at the next reconnect.
