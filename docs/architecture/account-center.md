# Account center ("Cá nhân")

Status: implemented 2026-11-09, PostgreSQL schema **203**. Target scale: 7–8k
accounts, 30k devices. Every list is bounded or keyset-paged, every query has a
matching index, and every screen loads with one request.

## Login sessions

- `user_sessions` keeps one row per signed-in client with `client_platform` /
  `client_name` (sent by the app at login). The refresh token (384 random bits)
  is stored as SHA-256: no slow hash is needed for high-entropy secrets, so a
  refresh is cheap.
- Access tokens carry `sid`. `authenticate` checks, in one primary-key lookup,
  account active + `token_version` current + session active and unexpired, so
  signing a session out takes effect immediately (not after 15 minutes).
- At most `MAX_SESSIONS_PER_ACCOUNT` (20) active sessions; logging in beyond
  that signs out the least recently used one.
- Revocations are published on `account.sessions.revoked`; realtime-service
  closes those sockets (code 4003, event `session_revoked`) and the app returns
  to sign-in.

| Endpoint | Purpose |
|---|---|
| `GET /me` | Profile + counters (owned, shared, pending invitations) |
| `PATCH /me` | Rename (`full_name`) |
| `POST /me/password` | Change password: bumps `token_version`, signs out other sessions, returns a new access token for this one |
| `GET /me/sessions`, `DELETE /me/sessions/:id`, `POST /me/sessions/revoke-others` | Session management |
| `DELETE /me` | Delete the account (password; refused with `ACCOUNT_OWNS_DEVICES` while owning devices) |

A wrong password answers **403 `INVALID_PASSWORD`**, never 401, so it is not
mistaken for an expired token.

## Device sharing

PostgreSQL already enforced the rules (single owner, owner-only grants, owner-
only and non-delegable scopes never shared). The API adds invitations by e-mail
(accepted in the app by whoever signs in with that address), presets by role and
limits.

- Roles: **viewer** = `device.view` (+ `camera.view`), **controller** = every
  delegable scope of the product. Owner-only: recording deletion, PIN codes,
  safety settings, sharing, unpairing.
- `MAX_DEVICE_MEMBERS` (10) members + open invitations per device;
  invitations expire after `INVITE_TTL_HOURS` (168).
- Every membership change, inside its transaction, recomputes the device
  audience from PostgreSQL and queues an `access` event in
  `device_shadow_outbox` (projection into the Mongo shadow), revokes open camera
  sessions of removed members, then publishes `device.access.changed`.
- realtime-service keeps an in-memory audience per device (only connected
  accounts), so telemetry, events and presence reach owner and members without a
  database lookup per message; members are told `device_access_granted` /
  `device_access_revoked`.

| Endpoint | Who |
|---|---|
| `GET /devices/:mac/members`, `POST /devices/:mac/invites`, `DELETE /devices/:mac/invites/:id`, `PATCH`/`DELETE /devices/:mac/members/:accountId` | Owner |
| `GET /me/sharing`, `POST /me/invites/:id/accept`, `POST /me/invites/:id/decline`, `DELETE /devices/:mac/membership` | Invitee / member |

Personal events (`sharing_invite_received`, `sharing_member_joined`, …) travel on
`account.event`.

## Notifications

No copy per recipient is written: the notification center reads
`device_events` (severity warning/critical) of the devices the user may see,
through the index `device_event_alert_timeline (device_id, severity,
received_at, _id)`. Members only see events after they joined.

- Categories (`shared/notification-categories.js`): safety, security, camera,
  outdoor, device. Users mute categories in `account_preferences`; **safety
  cannot be muted** (database CHECK and API).
- `notifications_seen_at` is the read watermark; `GET /me/badges` counts unread
  notifications (capped at 100) and pending invitations for the tab badge.
- The worker adds `category` to realtime `device_event` messages, so the app
  shows live alerts that respect mutes.
- Messages from the user's own automations (`account_notifications`, schema
  207) are merged in: items carry `kind` (`device_event` or `automation` with
  `title`, `body`, `automation_id`), the cursor carries the kind of the last
  item, and the badge counts both. They are pushed as `notification_created`
  and cannot be muted ([scenes.md](scenes.md#automations-tự-động)).

Endpoints: `GET /me/notifications?before=&limit=`, `POST /me/notifications/seen`,
`GET /me/badges`, `GET`/`PATCH /me/preferences`.

## Activity history

`GET /me/activity` merges the caller's device operations (`device_operations`,
read-only "query" operations excluded) with account, device-management and
sharing actions recorded in `device_audit_logs`. Both are read through
`(actor, time DESC, id DESC)` indexes; the cursor is the exact last item, so
pages never skip or repeat entries with equal timestamps.

## Tests

API Gateway integration tests run against a real PostgreSQL (and a
MongoDB-compatible server for notifications) when the environment provides one:

```powershell
$env:TEST_PG_URL = "postgres://postgres:<password>@127.0.0.1:5433/postgres"
$env:TEST_MONGO_URL = "mongodb://127.0.0.1:27017"   # optional, notification tests
cd api-gateway; npm test
```

Without these variables the database tests are skipped.
