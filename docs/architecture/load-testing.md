# Load testing and measurements ("Kiểm thử tải")

Status: implemented 2026-11-22; Simulator rebuilt on official entry points
only and EMQX broker 2026-11-27. Goal: show with numbers that the system runs
well at the target scale (7–8k accounts, 30k devices) and produce charts and
tables for the thesis report.

## Three tools, one picture

| Tool | What it does | Where |
|---|---|---|
| Device Simulator, "Tạo người dùng và thiết bị" | Creates the load: users registered through the API, devices made with the factory API, claimed by their users and connected over MQTT, telemetry every N seconds | Console → Simulator → Kiểm thử tải |
| Simulator, "Đo độ trễ đầu-cuối" | Measures what a user feels while the load runs: commands from app to device and back, or the app's reads | same page, below the runs |
| Prometheus + Grafana (optional) | Records every service's numbers over time: API latency, command latency, telemetry rate, broker connections, CPU, memory, event loop | `docker compose --profile monitoring up -d`, then http://localhost:3005 |

## The Simulator is an outsider

The Simulator talks to the system only through the doors a phone and a device
use, so what it measures is what users would get:

| What | Door | Who acts |
|---|---|---|
| Register, sign in, claim, unpair, delete the account, read a device's state, events and commands | public API (port 3000) | each simulated user, with its own session |
| Make a device (factory record + MQTT login), ask whether it is claimed, retire it | factory API (port 3000, `X-Factory-Key`; docs/architecture/mqtt-security.md) | the Simulator as a factory |
| Telemetry, events, acknowledgements, commands, topology | MQTT (port 1883) | each virtual device, with its own login |

It never opens the system's databases. Its own data (runs, users, devices and
their secrets, encrypted with `CREDENTIAL_ENCRYPTION_KEY`) is in its own
MongoDB (`simulator-mongodb`). What the Console shows about the system side
comes through these doors too: a device's backend state and events are read
as its user; ingest latency is measured by the API Gateway on its own data
(`GET /admin/load/ingest-latency`, last 30 s, p50/p95 from the device clock to
the database).

## One computer or two

| | One computer | Two computers |
|---|---|---|
| Computer A | everything | the system (`docker-compose.yml`) and the Admin Console (`docker-compose.admin-console.yml`) |
| Computer B | — | the Simulator and its MongoDB (`docker-compose.simulator.yml`) |
| Simulator reaches the system | `host-gateway` (this computer) | A's IP: `SMARTHOME_SYSTEM_HOST` in B's root `.env` |
| Console reaches the Simulator | `http://host.docker.internal:4001` (default) | `SIMULATOR_URL=http://<B's IP>:4001` in A's root `.env` |

On two computers the numbers of the system are no longer disturbed by the
Simulator's own work (30 000 devices are about 30 000 MQTT sockets and the
work of making their packets), which is the point of the split.

Two-computer checklist:

1. Wired LAN; a fixed IP for A (router reservation or static address).
2. On A, root `.env`: `PUBLISH_HOST=0.0.0.0` (API 3000 and media 8090 on the
   LAN; MQTT 1883 is on the LAN by default), `SIMULATOR_URL=http://<B>:4001`.
   Windows firewall on A: allow inbound TCP 3000, 1883 and 8090 from B's IP
   only. Then `docker compose up -d` and
   `docker compose -f docker-compose.admin-console.yml up -d`.
3. On B: Docker Desktop (disk image on its own fast drive), a checkout of the
   repository, `device-simulator/.env.docker` from `docker.env.example` with
   the same `ADMIN_TOKEN` (= A's `SIMULATOR_ADMIN_TOKEN`) and `FACTORY_API_KEY`
   (= A's), and a root `.env` with `SMARTHOME_SYSTEM_HOST=<A's IP>` and
   `SIMULATOR_PUBLISH_HOST=0.0.0.0`. Firewall on B: allow inbound TCP 4001
   from A's IP only. Then
   `docker compose -f docker-compose.simulator.yml up -d --build`.
4. Both clocks synchronized (Windows: Settings → Time → "Sync now", same time
   server). Ingest latency and command latency compare a device's clock (B)
   with the backend's (A); a clock off by 2 s adds 2 s to every number.
5. Console → Simulator → Hệ thống: every check green (API Gateway, factory
   API key, MongoDB, MQTT port, catalog).

## Running a test

1. Start the system, and the monitoring profile:
   `docker compose --profile monitoring up -d` (Prometheus on
   http://localhost:9090, Grafana on http://localhost:3005, read-only without
   signing in; admin password `GRAFANA_ADMIN_PASSWORD`, default `admin`).
2. For a large run, raise the limits on both sides (the Gateway's defaults,
   20 registrations and 100 sign-ins a minute per address, need about 2 hours
   for 2 500 users):
   - root `.env` on A: `RATE_LIMIT_REGISTER_PER_IP_PER_MINUTE=1200` and
     `RATE_LIMIT_LOGIN_PER_IP_PER_MINUTE=1200`, then `docker compose up -d api-gateway`;
   - `device-simulator/.env.docker`: `GATEWAY_REGISTER_PER_MINUTE=1200`,
     `GATEWAY_LOGIN_PER_MINUTE=1200`, and `MAX_DEVICES_PER_RUN`,
     `MAX_ACTIVE_DEVICES` (40 000) and `MAX_TELEMETRY_MESSAGES_PER_SECOND` (2 000)
     covering the run's worst case (users × the most devices per user), then
     `docker compose -f docker-compose.simulator.yml up -d --force-recreate simulator-backend`.

   Then create the users and devices (preset 2 500 users × 3–5 devices ≈ 10 000,
   at most 12 500; 7 500 × 3–5 ≈ 30 000) and wait until the live board shows the
   devices connected and telemetry steady. Afterwards set the Gateway's limits
   back (the Gateway is on the internet through the tunnel); the Simulator waits
   out any refusal (429) and retries.
3. Run "Đo độ trễ đầu-cuối":
   - **Lệnh điều khiển**: N simulated users each send K harmless commands to
     their online devices (lock, stop watering, resume siren, clear the
     display: normal risk, no confirmation, idempotent, inputs with defaults;
     commands answered at once are preferred over ones that wait for a motor).
     Latency = from the request until the device's result is recorded
     (`completed_at`, read back by the user with
     `GET /devices/:mac/operations/:id`); "trong backend" = from the
     operation's `created_at` to `completed_at`. 30 s without a result counts
     as `no_result_30s`.
   - **Người dùng mở app**: N users each open the app K times (devices list,
     badges, notifications); each request is timed.
   - "Cùng lúc" = users acting at the same time. Each result records the
     parameters, how many devices were connected and the telemetry rate when it
     started, and the machine (CPU cores, model, RAM).
4. Keep the Grafana dashboard ("SmartHome — Kiểm thử tải") open during the run;
   set its time range to the test and take screenshots for the report.
5. Download each result as CSV (one row per request: time, latency, backend
   time, ok, error) or JSON (summary + samples) for tables and charts.

Suggested series for the report: 0 / 10 000 / 20 000 / 30 000 devices
connected, and for each a command probe (e.g. 200 users × 5 commands, 50 at a
time) and an app probe (500 users × 3, 100 at a time). Note the machines.

## How the Simulator stays steady

Creating, restarting and cleaning thousands of users and devices must not be
what breaks first.

- **Generation** works user by user (`GENERATION_CONCURRENCY` users at a time):
  register (a lost answer is recovered by signing in with the random password
  only the Simulator holds), one factory call for all of the user's devices
  (a MAC that already exists gets a new identity), one claim per device (a lost
  answer is recovered from the user's device list), then the switched-on
  devices are handed to the connect scheduler. Every step can be repeated, so
  "Tạo bù phần thiếu" and a restart continue where generation stopped.
- **Connect scheduler** (`runtime/connect-scheduler.ts`): every bulk MQTT
  connection — generation, a restart, "Bật lại thiết bị", the Xưởng page —
  goes through one queue. At most `MQTT_CONNECTS_PER_SECOND` (50) start per
  second and `MQTT_CONNECT_CONCURRENCY` (200) wait for their CONNACK at once.
  A device that cannot connect (timeout, broker busy or restarting) is tried
  again after 5 s, 10 s, 20 s… up to 5 minutes, each ±30 %, without failing its
  user or its run. A login the broker refuses is not retried: the device shows
  "Broker từ chối đăng nhập" and an event is written. After a broker restart,
  connected devices come back by themselves, each after 5–30 s.
  The live board's "Đang mở kết nối" shows the queue, the retries and refusals.
- **Restart**: claimed, switched-on devices are checked with the factory API
  (one call per 500 devices; a device unpaired while the Simulator was down is
  not started), then queued with the connect scheduler.
- **Cleanup** ("Dọn dữ liệu", or 24 h after a run with automatic cleanup) runs
  in the background, `CLEANUP_CONCURRENCY` (8) users at a time. For each user:
  its devices are switched off, then signed in as the user it unpairs its
  devices and deletes the account (`DELETE /me`), then the devices are retired
  with the factory API (factory record, MQTT login and the system's data about
  them), then the Simulator forgets the records and the virtual SD cards. The
  run shows "Đang dọn" with the users done; the Console answers at once.
  A user is **blocked** (needs a person) when its account owns a device the
  Simulator did not make, or one of its devices is owned by another account;
  it is **failed** after three attempts on errors. Either way it is kept, listed
  with the reason, and the others go on; "Dọn dữ liệu" again finishes the rest.
  A cleanup interrupted by a restart resumes by itself.
- **Overload**: the warning "Simulator đang quá tải" appears when the
  Simulator's event loop p99 is above 200 ms, i.e. it cannot keep its own
  schedule. CPU above 100 % alone is not overload (Node uses several cores).

## Storage, backups and restore

Data lives in Docker named volumes, inside Docker Desktop's disk image. Put
that image on drive E: once: Docker Desktop → Settings → Resources → Advanced
→ Disk image location → `E:\DockerDesktop`, then "Apply & restart".

| Volume | Holds |
|---|---|
| `postgres_data` | accounts, devices, factory records, MQTT logins |
| `mongodb_data`, `mongodb_config` | shadows, telemetry, events |
| `emqx_data` | retained messages, broker state |
| `voice_data` | voice verification cohort |
| `prometheus_data` | 7 days of metrics |
| `simulator_mongodb_data`, `simulator_mongodb_config` | the Simulator's registry (its project) |
| `simulator_media` | virtual cameras' recordings (its project) |

`docker compose down` keeps the volumes; `docker compose down -v` deletes them.

Backup, while the containers run:
`powershell -ExecutionPolicy Bypass -File scripts\backup.ps1` writes
`E:\smarthome_data\backups\<date-time>\` with `postgres-smarthome.dump`,
`mongodb.archive.gz`, `emqx-export-<date>.tar.gz` (keep its name: EMQX only
imports an archive under the name it was exported with), `voice-data.tgz` and,
when the Simulator runs on this computer, `simulator-mongodb.archive.gz`.

Restore (into running containers, replacing what is there):

```powershell
$b = 'E:\smarthome_data\backups\<date-time>'
docker cp "$b\postgres-smarthome.dump" postgres:/tmp/r.dump
docker exec postgres pg_restore -U postgres -d smarthome --clean --if-exists /tmp/r.dump
docker cp "$b\mongodb.archive.gz" mongodb:/tmp/r.gz
docker exec mongodb mongorestore --drop --gzip --archive=/tmp/r.gz
$e = (Get-Item "$b\emqx-export-*.tar.gz").Name
docker cp "$b\$e" "emqx:/tmp/$e"
docker exec emqx /opt/emqx/bin/emqx ctl data import "/tmp/$e"
```

Then `docker compose restart api-gateway real-time-service mqtt-worker-service`.
The Simulator's registry is restored the same way into `simulator-mongodb`;
it only works with the same `CREDENTIAL_ENCRYPTION_KEY`.

## Metrics (Prometheus)

Each service serves `/metrics` on its own port **inside the Docker network
only** (not published, not in the tunnel): api-gateway `9101`
(`METRICS_PORT`, 0 = off), real-time-service `9102`, mqtt-worker-service
`9100`; EMQX at `emqx:18083/api/v5/prometheus/stats`. All Node services include
the standard process metrics (`process_cpu_seconds_total`,
`process_resident_memory_bytes`, `nodejs_eventloop_lag_p99_seconds`…) with a
`service` label.

| Metric | Service | Meaning |
|---|---|---|
| `smarthome_http_request_duration_seconds{method,route,status}` | Gateway | every API request, by route template (`/devices/:mac`, never raw URLs) |
| `smarthome_device_operation_duration_seconds{result}` | Gateway | command accepted → device result (succeeded, failed, rejected, timed_out) |
| `smarthome_push_notifications_total{result}` | Gateway | sent / invalid_token / failed |
| `smarthome_assistant_turns_total{channel,outcome}` | Gateway | assistant turns |
| `smarthome_realtime_connections`, `smarthome_realtime_accounts` | realtime | open WebSockets and connected accounts |
| `smarthome_realtime_messages_total{event}` | realtime | messages pushed to apps |
| `smarthome_telemetry_processed_total`, `…_rejected_total`, `smarthome_telemetry_processing_duration_seconds` | worker | telemetry throughput and processing time |
| `emqx_connections_count`, `emqx_messages_received`, `emqx_authentication_success`/`_failure` … | EMQX | broker connections, message rates, logins accepted and refused |

Prometheus (`monitoring/prometheus.yml`) scrapes every 5 s and keeps 7 days in
the `prometheus_data` volume. Grafana is provisioned from
`monitoring/grafana/` with the dashboard `smarthome.json`.

## Simulator API

| Route | Notes |
|---|---|
| `GET /api/overview` | the Simulator's own numbers: process, runtimes, rates, connect scheduler (`connects`), limits |
| `POST /api/simulation-runs/:id/cleanup` | starts the cleanup in the background (202); the run's `status` and `cleanup_progress` show how it goes |
| `GET /api/probes` | the live probe (summary) and the last 50 results |
| `POST /api/probes {kind: commands\|app_reads, users ≤ 2000, per_user ≤ 20, concurrency ≤ 200}` | one probe at a time (409 otherwise) |
| `POST /api/probes/:id/stop` | stops taking new work; in-flight commands finish |
| `GET /api/probes/:id`, `GET /api/probes/:id/csv` | full result with samples (≤ 20 000), CSV |

Sign-ins happen before the clock starts (stored sessions, refreshed or a new
login), so the probe measures the app's work, not logins. Commands are paced
like a person tapping (200 ms between one user's commands) and stay under the
Gateway's per-account command limit (30/min). Code: `backend/src/workload/probe.ts`
(pure runner, tested with a fake API and clock), `probe-service.ts` (sessions,
public API, `load_probes` collection), `api/routes/probes.ts`,
`frontend/src/components/load/ProbePanel.tsx`.

## Tests

- api-gateway `test/factory.test.ts`: the factory API (key, tunnel, batches,
  idempotency, conflicts, retire with the device's data), the physical-device
  CLI, ingest latency; `test/metrics.test.ts`.
- database `v2-tests/database-contract.test.js`: `mqtt_accounts`, the
  `emqx_auth` role's column grant.
- real-time-service `test/metrics.test.ts`; mqtt-worker-service
  `test/processMetrics.test.js`.
- device-simulator: `connect-scheduler.test.ts` (rate, concurrency, retries,
  refusals), `cleanup-recovery.test.ts` (the four steps, blocked and failed
  users, resume), `generation-recovery.test.ts` (resume, lost registration
  answer), `ownership-recovery.test.ts`, `broker-login.test.ts`,
  `probe.test.ts`.
