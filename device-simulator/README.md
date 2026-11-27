# Device Simulator

The simulator creates real API accounts, makes virtual devices with the
system's factory API, claims them as their users through the API Gateway,
connects each runtime to MQTT and emits the same Product V2
telemetry/presence/ACK contracts as firmware.

It is an outsider to the system: it uses only the doors a phone, a device and
a factory use — the public API, the factory API (port 3000) and MQTT (port
1883) — and never opens the system's databases. Its own data is in its own
MongoDB. That is what makes it possible to run it on a second computer, and
what makes its measurements honest (docs/architecture/load-testing.md).

Virtual devices follow backend Hub–Node assignments. Nodes relay through the
active virtual Hub, switch to direct MQTT fallback when its lease disappears,
and return to relay after a valid topology update. Operation inputs are checked
again against the published catalog before state mutation.

Virtual security cameras (`prod_security_camera`) use the webcam and
microphone of the browser showing the Admin Console as their image sensor: the browser encodes H.264 + AAC with
WebCodecs (Chrome or Edge) and the backend plays the camera firmware, recording
1-minute CMAF files 24/7 into a virtual SD card (`SIMULATOR_MEDIA_ROOT`, whole-store
quota `SIMULATOR_MEDIA_QUOTA_BYTES`, default 10 GB, oldest minute recycled first).
Unpairing, an owner change or run cleanup wipes a camera's recordings. See
`docs/architecture/camera-contract.md`.
Each virtual device also has an RSA key pair (virtual devices share a pool of
eight): the public key goes to the system with the factory record, the private
key stays encrypted in the simulator registry. Credential envelopes are
decrypted only inside that virtual device; the registry stores only a verifier
digest, never plaintext PIN material.

## Starting it

From the repository root, after the system (`docker compose up -d`) and the
Admin Console (`docker compose -f docker-compose.admin-console.yml up -d --build`):

```powershell
Copy-Item device-simulator\docker.env.example device-simulator\.env.docker   # once, then fill it in
docker compose -f docker-compose.simulator.yml up -d --build
```

`device-simulator/.env.docker` needs `ADMIN_TOKEN` (= `SIMULATOR_ADMIN_TOKEN`
of the root `.env`), `FACTORY_API_KEY` (= `FACTORY_API_KEY` of the root `.env`)
and a private `CREDENTIAL_ENCRYPTION_KEY` (keep it: the registry's secrets are
encrypted with it). On a second computer, add a root `.env` there with
`SMARTHOME_SYSTEM_HOST=<IP of the system's computer>` and
`SIMULATOR_PUBLISH_HOST=0.0.0.0`; the full checklist (ports, firewall, clocks)
is in docs/architecture/load-testing.md, "One computer or two".

The Simulator has no web page of its own: it is the **Simulator** section of
the Admin Console (`http://localhost:4000`, docs/architecture/admin.md), shown
to the root and to staff with the `simulator.view` permission (reading) or
`simulator.manage` (everything). The section has five pages:

- **Kiểm thử tải**: pick a preset (5×2 devices up to 7 500 users × 3–5 devices ≈
  30 000) or set users, devices per user, telemetry period and products, then
  start a run. The live board shows connected devices, connections being
  opened (queued, retrying, refused), telemetry msg/s, bandwidth, publish
  failures, ingest latency (measured by the API Gateway: device clock → backend
  database, p50/p95 over the last 30 s), and the simulator's own CPU, memory
  and event-loop delay, so you can tell whether the backend or the simulator is
  the bottleneck. Runs are listed with their actions (pause, resume, stop
  devices, keep data, clean up) and, while cleaning, the cleanup's progress.
  Below them, **Đo độ trễ đầu-cuối** measures what users feel while the load
  runs (docs/architecture/load-testing.md).
- **Thiết bị ảo**: server-paged registry of devices (filter by run, product,
  status; search name, MAC, serial or owner email). A device's page shows what
  the device holds, its last MQTT packet, the backend's state and events (read
  as its user through the public API) and the commands it received.
- **Người dùng ảo**: simulated accounts; the selected account's app login (email,
  password on request), devices and actions stay visible beside the list.
- **Xưởng sản xuất**: manufacture blank devices with QR labels (see below).
- **Hệ thống Simulator**: dependency checks (API Gateway, factory API key,
  MongoDB, MQTT port, catalog) and the operations log.

Automatic runs expire after 24 hours; kept runs ("Giữ dữ liệu") remain until
explicit cleanup: "Dọn dữ liệu" removes everything the run created, kept or not
(the scheduled sweep never removes kept users). Cleanup runs in the background,
user by user: unpair the user's devices and delete the account through the
public API, retire the devices with the factory API, forget the records. Users
it cannot clean are listed with the reason; the others are not held up.
Data is kept in Docker named volumes (`simulator_mongodb_data`,
`simulator_media`), inside Docker Desktop's disk image.

## Load testing at scale

The simulator is sized for about 30 000 devices in one process (measured on the
runtime without network: 30 000 devices at 30 s telemetry = ~1 000 msg/s at
about a third of one CPU core; one MQTT connection costs ~30 KB of memory):

- Telemetry is scheduled with a binary heap (O(log n) per message).
- Message sequence numbers are leased from the registry in blocks
  (`SEQUENCE_LEASE_SIZE`); a clean stop returns the unused part.
- Registry state and runtime state are written in batches
  (`REGISTRY_STATE_FLUSH_INTERVAL_MS`); manual actions write through at once.
  The dashboard overlays live runtime state, so it never shows stale values.
- Simulator events are inserted in batches.
- MQTT connections in bulk go through one connect scheduler:
  `MQTT_CONNECTS_PER_SECOND` (50) a second, `MQTT_CONNECT_CONCURRENCY` (200)
  waiting for their CONNACK at once; a device that cannot connect is retried
  later (5 s … 5 min, jittered) without failing its user; a refused login is
  reported, not retried. Reconnects after a broker restart are spread over
  5–30 s.
- After a restart, ownership is checked with the factory API (one call per 500
  devices) and the connections are queued.

Generation runs `GENERATION_CONCURRENCY` users in parallel and paces itself on
the API Gateway's rate limits instead of fixed sleeps:
`GATEWAY_REGISTER_PER_MINUTE` and `GATEWAY_LOGIN_PER_MINUTE` (per client IP) and
`GATEWAY_CLAIM_PER_ACCOUNT_PER_MINUTE`. Registration is the real bottleneck: the
Gateway default of 20 registrations per minute needs about 6 hours for 7 500
users. For a large test raise `RATE_LIMIT_REGISTER_PER_IP_PER_MINUTE` and
`RATE_LIMIT_LOGIN_PER_IP_PER_MINUTE` in the root `.env` (passed to the API
Gateway) and `GATEWAY_REGISTER_PER_MINUTE` / `GATEWAY_LOGIN_PER_MINUTE` in this
Simulator's `.env.docker` to the same value (for example 1200), and
`MAX_DEVICES_PER_RUN`, `MAX_ACTIVE_DEVICES` and `MAX_TELEMETRY_MESSAGES_PER_SECOND`
to cover the run's worst case (users × the most devices per user); see
docs/architecture/load-testing.md.

## Factory: blank devices and QR labels

The **Xưởng sản xuất** page manufactures blank devices that belong to nobody.
Each one gets an identity kept in the Simulator's registry (MAC, claim secret,
MQTT password, key pair), is registered with the system's factory API (its
factory record and MQTT login; the system receives hashes only), a serial
number (`SX-CAM-2611-0007`) and a QR label. The label holds the same payload
the SmartHome app scans:

```json
{"type":"smarthome-device","version":1,"mac":"02:1A:7C:E4:3B:11","secret_key":"…"}
```

A powered-on blank device holds its broker session in pairing mode: it listens
on its own topology topic and publishes nothing (`runtime_state` =
`awaiting_claim`). Claiming it in the app (scan the label, or on the web use
"Dán mã ghép nối" with the copied code) makes the backend publish the topology
assignment; the device records that it was claimed and starts reporting like
any other device. Like a real factory, the Simulator does not learn who bought
it. When the owner unpairs it, the device is factory reset and waits for a new
owner with the same label. Factory devices are not part of any run, so run
cleanup never touches them; only unclaimed devices can be scrapped (retired
with the factory API).

Every simulated device, including run-generated ones, shows its label in the
device workbench (tab **Tem QR**): download as PNG, print, or copy the code.

API: `GET|POST /api/factory/batches`, `GET /api/factory/devices?batch_id=&include_pairing=1`,
`POST /api/factory/devices/:mac/power`, `POST /api/factory/devices/:mac/scrap`,
`POST /api/factory/batches/:id/scrap-unclaimed`, `GET /api/devices/:mac/pairing`.
Settings: `FACTORY_TELEMETRY_INTERVAL_SECONDS` (default 30) and
`FACTORY_MAX_BATCH_SIZE` (default 20).

A device claimed from the app sends no Wi-Fi network fingerprint, so each one
forms its own single-device network (no Hub–Node grouping).

## Recovering incomplete generation

The user list shows **created / planned** device counts and a separate claimed
count. A registered account can exist before login and device provisioning finish;
an account appearing in the list does not mean all its devices have been created.

On HTTP 429, the simulator honors `Retry-After` (or the server's retry message),
waits and retries up to five times. API Gateway authentication limits remain in
place. Pause/cancel interrupts the wait, and the run history records the retry.
A registration or a claim whose answer was lost is recovered (signing in with
the user's random password; finding the device in the user's list); other API
failures are reported rather than automatically replaying writes.

For a `partial` run, open **Lần chạy** and select **Tạo bù thiết bị còn thiếu**.
Existing accounts/devices are reused; completed users are skipped and explicitly
unpaired devices are not reclaimed. Once generation finishes successfully, the
run becomes `completed` even if its historical error counter is nonzero.
Runs already cleaned cannot be recovered by this action.

The Admin Console reaches the Simulator backend at `SIMULATOR_URL` (default
`http://host.docker.internal:4001`). HTTP 502/504 means it got no answer
(Simulator backend not running, or the address/firewall is wrong); 503
`SIMULATOR_NOT_CONFIGURED` means `SIMULATOR_ADMIN_TOKEN` is empty; 401 from the
Simulator means the two tokens differ.

## MQTT identity of virtual devices

The Simulator acts as the factory for virtual devices. Each virtual device gets
its own random broker password when it is made (stored encrypted in
`simulated_devices.mqtt_secret`); the factory API stores its hash in the
system's `mqtt_accounts` table, which EMQX checks at every login. The device
connects with username = MAC like a physical device and subscribes only to its
own topics; relay Nodes receive topology from their Hub's assignment. Retiring
a device (cleanup, scrapping) removes its factory record and its login together.
See `docs/architecture/mqtt-security.md`.
