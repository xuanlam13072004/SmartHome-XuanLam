# Device Simulator

The simulator creates real API accounts, factory-provisions virtual devices,
claims them through API Gateway, connects each runtime to MQTT and emits the
same Product V2 telemetry/presence/ACK contracts as firmware.

Virtual devices follow backend Hub–Node assignments. Nodes relay through the
active virtual Hub, switch to direct MQTT fallback when its lease disappears,
and return to relay after a valid topology update. Operation inputs are checked
again against the published catalog before state mutation.

Virtual security cameras (`prod_security_camera`) use the dashboard's webcam
and microphone as their image sensor: the browser encodes H.264 + AAC with
WebCodecs (Chrome or Edge) and the backend plays the camera firmware, recording
1-minute CMAF files 24/7 into a virtual SD card (`SIMULATOR_MEDIA_ROOT`, whole-store
quota `SIMULATOR_MEDIA_QUOTA_BYTES`, default 10 GB, oldest minute recycled first).
Unpairing, an owner change or run cleanup wipes a camera's recordings. Live and
playback delivery arrive with the media relay (camera contract step 3). See
`docs/architecture/camera-contract.md`.
Each virtual device also has its own RSA key pair: the public key is provisioned
in PostgreSQL, while the private key is encrypted in the simulator registry.
Credential envelopes are decrypted only inside that virtual device; the
registry stores only a verifier digest, never plaintext PIN material.

Start the full stack from the repository root:

```powershell
docker compose up -d api-gateway real-time-service mqtt-worker-service
docker compose -f device-simulator/docker-compose.yml up -d --build simulator-backend simulator-dashboard
```

Open `http://localhost:4000`. The dashboard has five pages:

- **Kiểm thử tải**: pick a preset (5×2 devices up to 7 500 users × 3–5 devices ≈
  30 000) or set users, devices per user, telemetry period and products, then
  start a run. The live board shows connected devices, telemetry msg/s,
  bandwidth, publish failures, ingest latency (device clock → backend database,
  p50/p95 over the last 30 s), and the simulator's own CPU, memory and
  event-loop delay, so you can tell whether the backend or the simulator is the
  bottleneck. Runs are listed with their actions (pause, resume, stop devices,
  keep data, clean up).
- **Thiết bị**: server-paged registry of devices (filter by run, product,
  status; search name, MAC, serial or owner email).
- **Người dùng**: simulated accounts; the selected account's app login (email,
  password on request), devices and actions stay visible beside the list.
- **Xưởng sản xuất**: manufacture blank devices with QR labels (see below).
- **Hệ thống**: admin token, dependency checks and the operations log.

Automatic runs expire after 24 hours; kept runs remain until explicit cleanup.
Persistent PostgreSQL and MongoDB data live under `E:\smarthome_data` as
configured by the root Compose file.

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
- Broker identities are registered once; after a broker reset a refused login
  re-registers the device's stored identity. Reconnects are jittered.
- After a restart, ownership is checked in batches and devices are restored 64
  at a time.

Generation runs `GENERATION_CONCURRENCY` users in parallel and paces itself on
the API Gateway's rate limits instead of fixed sleeps:
`GATEWAY_REGISTER_PER_MINUTE` and `GATEWAY_LOGIN_PER_MINUTE` (per client IP) and
`GATEWAY_CLAIM_PER_ACCOUNT_PER_MINUTE`. Registration is the real bottleneck: the
Gateway default of 20 registrations per minute needs about 6 hours for 7 500
users. For a large test raise `RATE_LIMIT_REGISTER_PER_IP_PER_MINUTE` in the
API Gateway env and `GATEWAY_REGISTER_PER_MINUTE` in the simulator env to the
same value (for example 1200), and `MAX_DEVICES_PER_RUN`, `MAX_ACTIVE_DEVICES`
and `MAX_TELEMETRY_MESSAGES_PER_SECOND` to cover the run.

## Factory: blank devices and QR labels

The **Xưởng sản xuất** page manufactures blank devices that belong to nobody.
Each one gets a factory identity in PostgreSQL (`factory_devices`), its own
broker account, a serial number (`SX-CAM-2611-0007`) and a QR label. The label
holds the same payload the SmartHome app scans:

```json
{"type":"smarthome-device","version":1,"mac":"02:1A:7C:E4:3B:11","secret_key":"…"}
```

A powered-on blank device holds its broker session in pairing mode: it listens
on its own topology topic and publishes nothing (`runtime_state` =
`awaiting_claim`). Claiming it in the app (scan the label, or on the web use
"Dán mã ghép nối" with the copied code) makes the backend publish the topology
assignment; the device records its new owner and starts reporting like any other
device. When the owner unpairs it, the device is factory reset and waits for a
new owner with the same label. Factory devices are not part of any run, so run
cleanup never touches them; only unclaimed devices can be scrapped.

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
Other API failures are reported rather than automatically replaying writes.

For a `partial` run, open **Lần chạy** and select **Tạo bù thiết bị còn thiếu**.
Existing accounts/devices are reused; completed users are skipped and explicitly
unpaired devices are not reclaimed. Once generation finishes successfully, the
run becomes `completed` even if its historical error counter is nonzero.
Runs already cleaned cannot be recovered by this action.

Both API Gateway and simulator backend must be running before verifying the
dashboard admin token. HTTP 502/504 indicates the dashboard cannot obtain a
backend response; an invalid token is reported as HTTP 401.

## MQTT identity of virtual devices

The Simulator acts as the factory for virtual devices. Each virtual device
gets its own broker password on first connection (stored encrypted in
`simulated_devices.mqtt_secret`), registered through the broker's Dynamic
Security API with the `MQTT_FACTORY_*` identity, and connects with
username = MAC like a physical device. Devices subscribe only to their own
topics; relay Nodes receive topology from their Hub's assignment. Cleanup that
retires a factory record also revokes the device's broker identity. See
`docs/architecture/mqtt-security.md`.
