# MQTT authentication and authorization contract

Status: implemented for the Docker development stack (Mosquitto 2.1.2 with the
Dynamic Security plugin). TLS is not enabled yet; see "Not covered yet".

## Principles

- Every MQTT connection is authenticated. Anonymous access is disabled.
- A physical device and a virtual device use the same identity model, topics
  and ACL. The broker, MQTT Worker, API Gateway and Flutter cannot tell them
  apart.
- A device can publish only its own uplink topics and subscribe only its own
  downlink topics. It cannot read or write another device's topics.
- Broker identity is a factory concern. Claim, unpair and ownership remain in
  PostgreSQL and do not change broker credentials.

## Identities

| Identity | MQTT username | Role | Who holds the password |
|---|---|---|---|
| Device (real or virtual) | Device MAC, upper case, `AA:BB:CC:DD:EE:FF` | `smarthome-device` | Device only (firmware NVS `factory/mqttPassword`; Simulator registry, encrypted) |
| MQTT Worker | `mqtt-worker-service` | `smarthome-backend` | Root `.env` → `MQTT_WORKER_PASSWORD` |
| Device factory (Simulator acts as the factory for virtual devices) | `device-factory` | `dynsec-admin` | Root `.env` → `MQTT_FACTORY_PASSWORD` |
| Broker administrator | `admin` | built-in `super-admin` | Root `.env` → `MQTT_ADMIN_PASSWORD` |

The device MQTT password is a random 256-bit secret generated per device at
the factory. It is separate from the claim `secret_key` printed on the QR
label, so knowing the claim secret does not allow impersonating the device on
the broker. The MQTT client id should equal the username (MAC).

## Topic ACL

`%u` is replaced by the connecting username (Mosquitto ≥ 2.1).

Role `smarthome-device`:

| Direction | Topic |
|---|---|
| publish | `smarthome/%u/telemetry`, `smarthome/%u/events`, `smarthome/%u/ack`, `smarthome/%u/status`, `smarthome/%u/topology/ack` |
| subscribe | `smarthome/%u/control`, `smarthome/%u/hub/control`, `smarthome/%u/topology` |

A Hub publishes relayed Node messages on its own uplink topics with a
`transport` envelope, so no cross-device ACL is needed. Relay Nodes receive
their topology from the Hub's assignment (the member list), not from the
broker; Nodes that are connected to the broker (Hub, direct, direct fallback)
read their own retained `smarthome/<mac>/topology`.

Role `smarthome-backend`: publish and subscribe `smarthome/#`.

Default ACL access stays at the plugin defaults: publish and subscribe denied
unless a role allows them.

## Provisioning and revocation

1. Factory creates the PostgreSQL `factory_devices` row (claim secret hash,
   credential public key).
2. Factory registers the broker client: `createClient` with username = MAC,
   the generated MQTT password and role `smarthome-device`. Registration is
   idempotent; an existing client gets `setClientPassword` and the role.
3. Factory writes the MQTT password to the device (NVS for ESP32; encrypted
   registry for the Simulator).
4. Retiring a device (Simulator cleanup deleting its factory record) calls
   `deleteClient`, which also disconnects an active session.

Unpair does not revoke broker access: the device still exists and keeps
reporting; MQTT Worker drops data from devices that are not claimed.

The Dynamic Security plugin rewrites its JSON file once per control message,
so factories must batch registrations (the Simulator batches for up to
250 ms). At about 30,000 clients one save takes roughly 150 ms on the
broker thread.

## Operations

- Root `.env` (Git-ignored, template `.env.example`) holds the three broker
  passwords used by Docker Compose interpolation.
- `mqtt-initialize` runs `mosquitto/initialize-dynsec.sh` after the broker is
  healthy. It is idempotent: creates roles/ACLs, creates or re-keys the
  `mqtt-worker-service` and `device-factory` clients.
- Broker state (Dynamic Security JSON and retained messages) is stored in
  `E:/smarthome_data/mosquitto`.
- Physical devices are registered with
  `node mqtt-worker-service/src/tools/provisionDeviceIdentity.js <MAC>`,
  which prints the generated password to flash into NVS.

## Not covered yet

- TLS on the MQTT listener (credentials currently travel in clear text on the
  LAN). Required before devices leave the lab.
- Per-device certificates (mTLS); can replace passwords later without
  changing topics or ACLs.
- The `device-factory` identity holds full Dynamic Security admin rights; a
  production factory service should be separated from the Simulator.
