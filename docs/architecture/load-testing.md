# Load testing and measurements ("Kiểm thử tải")

Status: implemented 2026-11-22. Goal: show with numbers that the system runs
well at the target scale (7–8k accounts, 30k devices) and produce charts and
tables for the thesis report.

## Three tools, one picture

| Tool | What it does | Where |
|---|---|---|
| Device Simulator, "Tạo người dùng và thiết bị" | Creates the load: users registered through the API, devices claimed and connected over MQTT, telemetry every N seconds | Simulator → Kiểm thử tải |
| Simulator, "Đo độ trễ đầu-cuối" | Measures what a user feels while the load runs: commands from app to device and back, or the app's reads | same page, below the runs |
| Prometheus + Grafana (optional) | Records every service's numbers over time: API latency, command latency, telemetry rate, CPU, memory, event loop | `docker compose --profile monitoring up -d`, then http://localhost:3005 |

Everything goes through the same public API, MQTT broker and databases as a
real phone and a real device; the backend never knows a client is simulated.

## Running a test

1. Start the system, and the monitoring profile:
   `docker compose --profile monitoring up -d` (Prometheus on
   http://localhost:9090, Grafana on http://localhost:3005, read-only without
   signing in; admin password `GRAFANA_ADMIN_PASSWORD`, default `admin`).
2. Raise the registration limits for a large run (`RATE_LIMIT_REGISTER_PER_IP_PER_MINUTE`
   in the Gateway env and `GATEWAY_REGISTER_PER_MINUTE` in the simulator env,
   e.g. 1200; see device-simulator/README.md) and create the users and devices
   (preset 7 500 users × 3–5 devices ≈ 30 000). Wait until the live board shows
   the devices connected and telemetry steady.
3. Run "Đo độ trễ đầu-cuối":
   - **Lệnh điều khiển**: N simulated users each send K harmless commands to
     their online devices (lock, stop watering, resume siren, clear the
     display: normal risk, no confirmation, idempotent, inputs with defaults;
     commands answered at once are preferred over ones that wait for a motor).
     Latency = from the request until the device's result is recorded
     (`device_operations.completed_at`); "trong backend" = from
     `accepted_at` (API accepted it) to `completed_at`. 30 s without a result
     counts as `no_result_30s`.
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
time) and an app probe (500 users × 3, 100 at a time). Note the machine: all
services, the databases and the simulator share one computer, so the numbers
are a lower bound of what the design allows.

## Metrics (Prometheus)

Each service serves `/metrics` on its own port **inside the Docker network
only** (not published, not in the tunnel): api-gateway `9101`
(`METRICS_PORT`, 0 = off), real-time-service `9102`, mqtt-worker-service
`9100`. All include the standard process metrics (`process_cpu_seconds_total`,
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

Prometheus (`monitoring/prometheus.yml`) scrapes every 5 s and keeps 7 days in
the `prometheus_data` volume. Grafana is provisioned from
`monitoring/grafana/` with the dashboard `smarthome.json`: overview (requests/s,
API p95, command p95, connections), API by status and slowest routes, command
latency p50/p95/p99 and results, telemetry rate and processing time, CPU /
memory / event loop per service, realtime messages, pushes and assistant
turns.

## Simulator API

| Route | Notes |
|---|---|
| `GET /api/probes` | the live probe (summary) and the last 50 results |
| `POST /api/probes {kind: commands\|app_reads, users ≤ 2000, per_user ≤ 20, concurrency ≤ 200}` | one probe at a time (409 otherwise) |
| `POST /api/probes/:id/stop` | stops taking new work; in-flight commands finish |
| `GET /api/probes/:id`, `GET /api/probes/:id/csv` | full result with samples (≤ 20 000), CSV |

Sign-ins happen before the clock starts (stored sessions, refreshed or a new
login), so the probe measures the app's work, not logins. Commands are paced
like a person tapping (200 ms between one user's commands) and stay under the
Gateway's per-account command limit (30/min). Code: `backend/src/workload/probe.ts`
(pure runner, tested with a fake API and clock), `probe-service.ts` (sessions,
Gateway, operation table, `load_probes` collection), `api/routes/probes.ts`,
`frontend/src/components/load/ProbePanel.tsx`.

## Tests

- api-gateway `test/metrics.test.ts`: route templates (no raw URLs), command
  histogram, process metrics, the separate port.
- real-time-service `test/metrics.test.ts`; mqtt-worker-service
  `test/processMetrics.test.js` (no duplicate metric names).
- device-simulator `test/probe.test.ts`: safe command choice, percentiles,
  commands measured to the device result (errors, missing results), app reads,
  stop, token refresh.
