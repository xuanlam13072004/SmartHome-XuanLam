# Device charts ("Biểu đồ hoạt động")

Status: implemented 2026-11-22.

Each device has a chart screen in the app (chart icon on the device page):
readings, events and commands over the last 24 hours (per hour), 7 days or
30 days (per day). Hours and days are cut in Vietnam time (UTC+7, no daylight
saving).

## API

`GET /devices/:mac/stats?range=24h|7d|30d` (default `24h`), any active
member of the device.

```json
{
  "success": true,
  "stats": {
    "range": "24h",
    "unit": "hour",
    "timezone": "Asia/Ho_Chi_Minh",
    "buckets": ["2026-11-21T15:00:00.000Z", "… 24 bucket starts"],
    "since": null,
    "measures": [{
      "property": "instances.kitchen_temperature.reported.temperature",
      "label": "Nhiệt độ", "instance_label": "Nhiệt độ DHT11",
      "unit": "celsius", "minimum": -40, "maximum": 125, "precision": 1,
      "points": [{ "avg": 31.2, "min": 30, "max": 32 }, null, "…"]
    }],
    "events": { "scope": "all", "total": 4, "per_bucket": [0, "…"],
                "by_name": [{ "event_name": "button_pressed", "label": "Nút trên thiết bị được nhấn", "count": 2 }] },
    "commands": { "total": 2, "per_bucket": [0, "…"],
                  "by_operation": [{ "operation": "alarm_siren.test_siren", "label": "Kiểm tra còi", "count": 2 }] },
    "generated_at": "2026-11-22T14:15:00.000Z"
  }
}
```

Every array is aligned with `buckets`; a `null` point means no reading in
that hour or day.

## What is counted

| Part | Source | Rule |
|---|---|---|
| Measures | MongoDB `device_telemetry` (time series, kept 30 days) | Catalog properties with `history: "sampled"`, a number type and a `maximum` (gas, smoke, temperature, humidity, soil moisture, water level, door angle, Wi-Fi signal). Unbounded counters (uptime, bytes) are left out. Average / lowest / highest per bucket, rounded to the catalog `precision`. |
| Events | MongoDB `device_events` (by `received_at`) | Owner: every event. Member: warnings and critical alerts only, as in the notification center. Names from `automations/labels.ts`. |
| Commands | PostgreSQL `device_operations` | Status `succeeded`; operations whose `ui_hint` is `query` (listing recordings) are not commands. Names from the catalog. |

Privacy: everyone sees data only from the moment they got the device
(`device_memberships.created_at`: the claim for the owner, joining for a
member; `since` is set when that falls inside the period) and only data
recorded under the current owner (`owner_id` snapshot in MongoDB), so a new
owner never sees the previous owner's home.

Bucket rule (one definition for MongoDB, PostgreSQL and the app): bucket
`i` starts at `start + i × size`, where `start` is the beginning of the
first hour/day in Vietnam time and `size` is one hour or one day; a record
belongs to `floor((time − start) / size)`.

## Load

- Indexes used: `device_telemetry {metadata.device_id, observed_at}`,
  `device_events {device_id, received_at}`, `device_operations
  {device_id, created_at}`.
- The answer is cached in Redis (`device_stats:v1:<mac>:<range>:<owner>:<viewer>:<bucket start>`):
  2 minutes for 24 hours, 10 minutes for 7/30 days. The key changes with the
  current hour/day, so a new bucket is never served from an old answer.
- The three reads run in parallel; the access check (PostgreSQL) always runs
  first, also for cached answers.

## App

`lib/features/device_stats/`: `DeviceStatsApi`, `deviceStatsProvider`
(family by device and period), `DeviceStatsScreen` (route
`/device/:mac/stats`) and `widgets/stats_charts.dart` (painted with
`CustomPainter`, no chart package): a 2px line of the average over a light
band from lowest to highest, columns for counts, hairline grid, the theme
primary as the only hue. Tap or drag picks an hour/day and shows its value
above the chart; the period summary shows otherwise. While another period
loads, the previous charts stay dimmed.

## Tests

- `api-gateway/test/device-stats.test.ts`: windows in Vietnam time, which
  readings and commands count, shaping; the API test (owner, member from
  joining with alerts only, previous owner hidden, cache, 403/400) needs a
  real MongoDB in `TEST_MONGO_URL` (FerretDB lacks `$floor`/`$divide` in
  `$group`).
- `smarthome_app/test/device_stats_test.dart`: parsing, labels, tapping a
  chart.
