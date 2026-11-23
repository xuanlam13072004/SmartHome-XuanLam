# Scenes ("Kịch bản") and automations ("Tự động")

Status: implemented 2026-11-13 in three phases: manual scenes + run history
(schema **205**), schedules (**206**), automations + suggestions (**207**).
Target scale: 7–8k accounts, 30k devices.

## Model

Scenes are **personal**, like rooms: each account builds its own from the
devices it can see, using only the operations it may run.

- `scenes (account_id, name, icon, position)`: name unique per account
  (case/spacing-insensitive); at most `MAX_SCENES_PER_ACCOUNT` (50).
- `scene_steps (scene_id, step_index, device_id, instance_id, operation_name,
  input, delay_seconds)`: at most `MAX_SCENE_STEPS` (10). `delay_seconds` is the
  wait before the step; the first step starts at once. Removing a device removes
  its steps. Inputs can never hold secrets (same DB check as device operations).
- `scene_runs` / `scene_run_steps`: one row per run and a copy of its steps, so
  editing or deleting the scene never changes a run in progress and history keeps
  its names. A partial unique index allows **one run in progress per scene**.

## Which operations a step may use

One rule, in `api-gateway/src/modules/scenes/actions.ts`, derived from the
catalog (no catalog change, so device catalog revisions are untouched). A step
must be fixed when the scene is saved, so these are excluded:

| Excluded | Why | Example |
|---|---|---|
| `effects: create_resource_session` | needs a person watching | camera live view, playback |
| no effect + `completion_signal: ack` | a query, not an action | `list_recordings` |
| input named `…_id` or `format: date-time` | runtime object or absolute time | `acknowledge_incident`, `delete_recordings` |

The account must be the owner or hold the operation's permission. The app shows
only what `GET /scenes/actions` returns.

**Protected steps:** operations whose catalog `confirmation` is not `none`
(e.g. unlocking the door, muting the siren). A scene containing one needs the
account password **on every run** (`X-Reauth-Token` from
`POST /auth/reauthenticate`), so such a scene can be neither scheduled nor
run by an automation.

## Running

1. `POST /scenes/:id/run` copies the steps, creates the run and sends every step
   that is due right away. Each step becomes a normal device operation (same
   permission and input checks as a tap in the app) with idempotency key
   `scene-run:<run>:<step>`, so a step is never sent twice.
2. The **scene runner** (`api-gateway/src/workers/sceneRunner.ts`, every second):
   - claims runs whose next step is due with `FOR UPDATE SKIP LOCKED` and a
     30-second lease on `next_step_at` (safe with several Gateway instances; a
     run left by a crash is picked up again and the idempotency key prevents
     duplicates);
   - copies finished device operations into their steps
     (`succeeded` / `failed` + reason, e.g. `OPERATION_TIMEOUT`); a step whose
     device was unpaired meanwhile fails with `DEVICE_REMOVED`;
   - closes runs with nothing left to wait for: `succeeded`, `partial` or
     `failed`. A failed step does not stop later steps;
   - every 10 minutes deletes finished runs older than
     `SCENE_RUN_RETENTION_DAYS` (30), 1000 at a time.
3. Every change is pushed to the account as the realtime event
   `scene_run_updated` (`data.run`). The app also reloads a running run every
   5 seconds as a fallback.

Load: the runner's queries touch only running runs and open steps (partial
indexes); scenes do not add work per device message.

## Schedules ("Hẹn giờ")

`scene_schedules (scene_id, account_id, local_time, days, timezone, enabled,
next_run_at, last_fired_at, last_result, last_run_id)`, at most
`MAX_SCHEDULES_PER_SCENE` (5) per scene; `(scene_id, account_id)` references the
scene, and one scene cannot have the same time and days twice.

- **Next occurrence** is computed by PostgreSQL:
  `scene_schedule_next_run(local_time, days, zone, after)` returns the first
  `local_time` on one of `days` (ISO weekdays, 1 = Monday) strictly after
  `after` in `zone` (IANA name; the app sends `Asia/Ho_Chi_Minh`,
  `AppConfig.timeZone`). Daylight-saving gaps and overlaps follow PostgreSQL's
  time zone rules.
- **Firing** (scene runner, every second, batches of 50): due schedules are
  locked with `FOR UPDATE SKIP LOCKED`; for each, creating the run
  (`insertRun`, trigger `schedule`) and moving `next_run_at` to the next
  occurrence after now are one transaction, so an occurrence fires **exactly
  once**, also with several Gateway instances. The first steps are sent right
  after COMMIT.
- **Outcome** in `last_result`: `started`, `skipped_running` (the previous run
  is still going; nothing is queued), `skipped_protected`, `skipped_empty`, or
  `missed` when the occurrence is more than 15 minutes late (Gateway down):
  it is recorded, not run late.
- **Protected steps:** a scene with one cannot get a schedule
  (`SCENE_PROTECTED_STEPS`), a schedule cannot be turned on for it, and adding
  such a step to a scene with an enabled schedule is refused
  (`SCENE_HAS_SCHEDULES`).
- Load: one partial index on `next_run_at WHERE enabled`; a popular minute
  (06:00) is drained 50 schedules per transaction until nothing is due.
- **Locked account** (docs/architecture/admin.md): while the company has
  locked the account, its schedules and automations pause: the occurrence
  passes (next time computed, state edge and event id recorded) without a run,
  a notification or a `last_result`, so unlocking does not replay anything.
  Devices themselves and the people they are shared with are not affected.

## Automations ("Tự động")

An automation is **Khi → Nếu → Thì**, personal like scenes
(`automations`, at most `MAX_AUTOMATIONS_PER_ACCOUNT` (30) per account):

- **Khi** (one trigger):
  - `state`: a device state becomes true for a comparison
    (`instances.door_position.reported.door_state eq "open"`), fired only on
    false → true (`trigger_matched`); still true does not fire again;
  - `event`: a device reports an event (`hazard.incident_started`); each event
    id is handled once (`last_event_id`);
  - `time`: a local time on chosen weekdays (`next_run_at`, the same
    `scene_schedule_next_run` and 15-minute missed rule as schedules).
- **Nếu** (optional): up to 3 comparisons on the devices' current state
  (MongoDB shadows), all true, and/or a daily active window
  (`automation_window_open(from, to, zone, at)`, 23:00–05:00 crosses midnight).
- **Thì**: run one of the account's scenes (`insertRun`, trigger `automation`,
  `scene_runs.automation_id`) and/or send the account a notification. Deleting
  the scene leaves the automation without one (`ON DELETE SET NULL (scene_id)`);
  removing the trigger device deletes the automation.
- **Không lặp lại trong** (`cooldown_seconds` 60/300/900/3600, default 300):
  no second action from a device trigger within that time.

**What may be watched** comes from the catalog, one rule in
`modules/automations/catalog.ts`: triggers are properties with
`automation.trigger`, conditions those with `automation.condition`, and only
comparable ones (boolean: is; enum: is / is not; number: above / below, within
min..max). Any device event may be a trigger. Connectivity
(`diagnostics.system.online`) comes from presence (`device.status`), not from
telemetry. A member (shared device) may watch any device they see; running the
scene still needs their operation permissions. `GET /automations/options` is
the only source of the app's pickers.

**Engine** (`workers/automationEngine.ts`): every Gateway subscribes to the
Redis channels the MQTT worker already publishes for the apps
(`device.telemetry`, `device.event`, `device.status`) and keeps an in-memory
index MAC → enabled device triggers. The MAC is read from the raw message
before parsing, so a device without automations costs one Map lookup
(measured: ~0.3 µs per message, 24k automations in ~26 MB; a device with
automations ~3 µs). The database is written only when a comparison changes.
Changes arrive on `automation.changed` (`{id}`), and the index is rebuilt every
5 minutes as a safety net. Messages published while no Gateway listens are not
replayed (state triggers recover with the next telemetry).

**Exactly once** (`modules/automations/firing.ts`): every Gateway hears every
message, so the automation's row decides: `SELECT … FOR UPDATE`, then
`trigger_matched` (state) or `last_event_id` (event) tells whether another
instance already handled it. Then, in order: trigger device still accessible
(else `unavailable`) → cooldown over (else nothing recorded) → window and
conditions (else `skipped_conditions`) → run the scene (`started`, or
`skipped_running` / `skipped_protected` / `skipped_empty`, `no_action` when it
has none) and insert the notification (`notified` when there is no scene). Runs
and notifications go out after COMMIT; the account gets `automation_fired`
(new status) and `notification_created`. Time triggers are fired by the scene
runner with `FOR UPDATE SKIP LOCKED`, like schedules.

**Notifications** (`account_notifications`, kept
`ACCOUNT_NOTIFICATION_RETENTION_DAYS` (30)): merged into
`GET /me/notifications` with device events (order: time desc, device events
first at the same millisecond, id desc; the cursor carries the kind) and into
the badge count. They are never muted: the user asked for them.

**Suggestions ("Gợi ý")** (`modules/automations/suggestions.ts`): ready-made
automations for the account's devices, added with one tap (with the scene they
run, named without clashing). They only join devices together or report what
the devices do not already report (the roof closes for rain and the garden
waters itself on the devices; warning/critical events are notifications
anyway):

| Template | Needs | Automation |
|---|---|---|
| `gas_vent` | safety controller + roof the account may open | safety incident starts → scene "Mở mái thông gió" |
| `night_lock` | door lock the account may lock | 23:00 daily, if not locked → scene "Khóa …" + notification |
| `night_door` | door position | door opens between 23:00 and 05:00 → notification |
| `rain_stop` | rain sensor + pump the account may stop | rain detected → scene "Dừng tưới" |
| `offline` | safety controller or camera | it goes offline → notification |

A suggestion is identified by template and devices (`automations.suggestion`)
and offered until an automation made from it exists.

## API

| Endpoint | Purpose |
|---|---|
| `GET /scenes` | Scenes with steps (each with `available`, `protected`), last run, limits |
| `GET /scenes/actions` | The caller's devices with the operations a step may use (labels, input schema) |
| `POST /scenes` `{name, icon, steps}` | Create |
| `PATCH /scenes/:id` `{name?, icon?, steps?}` | Rename / icon / replace all steps |
| `DELETE /scenes/:id` | Delete (history stays) |
| `PUT /scenes/order` `{scene_ids}` | Reorder (must list every scene once) |
| `POST /scenes/:id/run` | Run; `403 REAUTHENTICATION_REQUIRED`, `409 SCENE_ALREADY_RUNNING`, `409 SCENE_EMPTY` |
| `POST /scenes/:id/schedules` `{time: "HH:MM", days: [1-7], timezone}` | Add a schedule (`SCENE_SCHEDULE_DUPLICATE`, `SCENE_SCHEDULE_LIMIT`, `SCENE_PROTECTED_STEPS`, `INVALID_TIMEZONE`) |
| `PATCH /scene-schedules/:id` `{time?, days?, timezone?, enabled?}` | Change or turn on/off |
| `DELETE /scene-schedules/:id` | Delete |
| `GET /scene-runs?scene_id=&before=&limit=` | History, newest first, keyset paged |
| `GET /scene-runs/:runId` | One run with its steps (`automation: {id, name}` when an automation started it) |
| `GET /automations` | Automations (trigger, conditions and their `available`, window, scene, notification, last result), limits |
| `GET /automations/options` | The caller's devices with the states (triggers, conditions) and events an automation may use |
| `POST /automations` | Create (`AUTOMATION_TRIGGER_INVALID`, `AUTOMATION_CONDITION_INVALID`, `SCENE_PROTECTED_STEPS`, `AUTOMATION_NAME_TAKEN`, `AUTOMATION_LIMIT`) |
| `PUT /automations/:id` | Replace the definition (history stays) |
| `PATCH /automations/:id` `{enabled}` | Turn on/off (on starts from the current state) |
| `DELETE /automations/:id` | Delete |
| `GET /automations/suggestions` | Suggestions not added yet (at most 8) |
| `POST /automations/suggestions/apply` `{key, timezone}` | Add one (`SUGGESTION_ALREADY_ADDED`, `SUGGESTION_NOT_FOUND`) |

Adding a step that needs the password to a scene an automation runs is refused
(`SCENE_USED_BY_AUTOMATION`). `GET /scenes` returns each scene's `schedules`.
Tests: `api-gateway/test/scenes.test.ts`, `scene-schedules.test.ts`,
`automations.test.ts` (two engines standing for two Gateways, cooldown, window,
conditions, missed, lost access, suggestions, merged notifications).

## App

`smarthome_app/lib/features/scenes/`: list with one-tap **Chạy** (password
prompt for protected scenes), live progress sheet, editor (name, icon, steps
grouped by room, inputs generated from the catalog schema, delay per step,
drag to reorder), run history, and "Hẹn giờ" per scene (time + weekdays with
Hằng ngày / Thứ 2–6 / Cuối tuần presets, on/off switch, last result); the card
shows the next scheduled run. Rooms and scenes share the reorder sheet
(`core/widgets/sheets/reorder_sheet.dart`).

`smarthome_app/lib/features/automations/`: the "Tự động" tab of the scenes page
(suggestions with **Thêm**, then the automations with an on/off switch, Khi → Thì
summary, next time or last result), the editor (Khi: state / event / time; Nếu:
up to 3 states + active window; Thì: scene and/or notification text; cooldown),
pickers grouped by room with comparisons built from the catalog. Automation
messages appear in "Thông báo" (and as a snackbar), runs in history as
"Tự động: <tên>".
