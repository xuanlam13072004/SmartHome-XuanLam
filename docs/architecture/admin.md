# Admin Console

Status: implemented 2026-11-23. It replaces the "Quản trị" page that used to
live inside the Simulator dashboard.

The company's own web app (`admin-console/`, http://localhost:4000):
system numbers, customer support, payments, and the **Device Simulator as one
section of it**. Customers never see it. Staff sign in with their own account:

- one **root** admin (the project owner), created on the server with a command;
- **sub-admins** the root creates in the Console, each with only the
  permissions the root ticks (for example "payments only", or "Simulator
  only").

## Pieces

```
Browser ──cookie sh_console──▶ Admin Console (admin-console/, port 4000)
                                 ├─ /api/admin/*     ──X-Admin-Key + staff session──▶ API Gateway /admin/*
                                 └─ /api/simulator/* ──Bearer SIMULATOR_TOKEN───────▶ Simulator backend /api/*
                                        (both inside the Docker network smarthome_net)
```

The Console and the Simulator backend run as their own Docker group,
`admin-console` (`docker-compose.admin-console.yml` at the repository root),
apart from the smart home system (`docker-compose.yml`); they join the
system's network `smarthome-xuanlam_smarthome_net`.

- **Console backend** (`admin-console/backend`, Fastify): signs staff in,
  keeps the session in an httpOnly cookie, forwards calls and adds the server
  keys. The keys never reach the browser.
- **API Gateway** (`api-gateway/src/modules/admin`): the source of truth for
  staff, sessions and permissions; it checks the permission of every `/admin`
  call itself.
- **Simulator backend** (`device-simulator/`): no web page of its own any
  more. Its API is published on `127.0.0.1:4001` only, for debugging; the
  Console is its only user.
- **Web app** (`admin-console/frontend`, React + Vite): built into the same
  container and served by the backend.

## Staff and permissions

| Permission | Group | Allows |
|---|---|---|
| `overview.view` | Tổng quan | numbers and charts |
| `accounts.view` | Tài khoản khách | search and open customer accounts |
| `accounts.manage` | Tài khoản khách | lock / unlock, sign out everywhere (includes view) |
| `payments.view` | Thanh toán | orders and unmatched transfers |
| `payments.manage` | Thanh toán | confirm money, cancel orders (includes view) |
| `plans.gift` | Gói | give or extend a plan (includes `accounts.view`) |
| `assistant.view` | Trợ lý | assistant usage |
| `audit.view` | Nhật ký | the administration log (also the log inside an account) |
| `simulator.view` | Simulator | runs, virtual devices and users, operations log |
| `simulator.manage` | Simulator | load tests, latency probes, controlling virtual devices, the factory (includes view) |

Presets in the form: **Hỗ trợ khách hàng** (`accounts.manage`, `audit.view`),
**Kế toán** (`overview.view`, `payments.manage`, `plans.gift`), **Kỹ thuật**
(`overview.view`, `simulator.manage`). The list lives in
`api-gateway/src/modules/admin/permissions.ts`; the database stores codes as
text (no CHECK), so adding one later needs no migration.

Rules:

- The **root** has every permission plus `staff.manage` (the "Nhân viên"
  page), which is never granted to anyone else. Exactly one root exists
  (unique index). The Console cannot edit, lock or reset the root; the server
  command can.
- A sub-admin sees only the menu items of their permissions; the Gateway and
  the Console refuse the rest (403 `STAFF_FORBIDDEN`) even if called directly.
- Changing someone's permissions, locking them or resetting their password
  takes effect at once for `/admin` (checked on every call) and within 10 s for
  the Simulator section (the Console's short cache).
- Nobody can act on their own account from "Nhân viên"; "Tài khoản của tôi" is
  for that.

## Signing in

- E-mail and password (argon2, at least 10 characters). Five wrong passwords
  lock the account for 15 minutes; unknown e-mails take the same time to
  answer as known ones.
- A new staff member, or one whose password the root reset, gets a temporary
  password (`xxxx-xxxx-xxxx`) shown once; nothing works until it is replaced
  (`STAFF_PASSWORD_CHANGE_REQUIRED`).
- Session: a random 32-byte token in the cookie `sh_console` (httpOnly,
  `SameSite=Strict`, `Secure` with `ADMIN_CONSOLE_COOKIE_SECURE=true`); the
  database keeps only its SHA-256. It ends after 30 minutes idle or 12 hours;
  at most 10 sessions per person (the oldest goes).
- Changing one's password signs out the other sessions; "Tài khoản của tôi"
  lists one's sessions and can sign the others out. Locking a staff member or
  resetting their password signs them out everywhere.
- Two-step verification for the root is planned for later.

## Who can reach it

1. **Network**: the Console is published on `127.0.0.1:4000` (this computer).
   `ADMIN_CONSOLE_HOST=0.0.0.0` in the root `.env` opens it to the LAN. It is
   never routed through Cloudflare Tunnel.
2. **Console**: every API call needs the session cookie; every change also
   needs the header `X-Console-Request: 1`, which another site cannot send
   (403 `CONSOLE_REQUEST_REQUIRED`). Pages are served with `X-Frame-Options:
   DENY`. Signing in is only possible through `/api/session/login`.
3. **Gateway guard** (`guard.ts`, an `onRequest` hook on every admin route):
   - `ADMIN_API_KEY` empty → the API does not exist (404);
   - Cloudflare headers (`cf-ray`, `cf-connecting-ip`) → 403
     `ADMIN_INTERNAL_ONLY`: only reachable inside the Docker network;
   - wrong key → 401 `ADMIN_KEY_INVALID` (constant-time comparison, at most 20
     wrong keys per minute per address);
   - then the staff session, the temporary-password rule and the route's
     permission (`config.adminPermission`; a route that declares none is
     refused, so a forgotten check cannot open a hole).
   A customer's access token is never accepted on `/admin`.
4. **Simulator**: the Console lets `GET` through with `simulator.view` and
   everything else with `simulator.manage`, then calls the Simulator with its
   `ADMIN_TOKEN`. The Simulator trusts nobody else.
5. **Reason and log**: every change to a customer, plan, payment or staff
   member asks for a reason (3–300 characters), written to `admin_audit_log`
   in the same transaction, with who did it.

## Setting it up

1. Two values in the root `.env` (Git-ignored):
   - `ADMIN_API_KEY`: a random key, 32+ characters:
     `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
   - `SIMULATOR_ADMIN_TOKEN`: the same value as `ADMIN_TOKEN` in
     `device-simulator/.env.docker` (leave empty if the Simulator is not used).
2. The system: `docker compose up -d --build` (`db-initialize` adds the
   migrations first).
3. The Console and the Simulator:
   `docker compose -f docker-compose.admin-console.yml up -d --build`
   (the file sits at the root so Compose reads the root `.env`).
4. Create the root, once:
   `docker compose exec api-gateway node dist/tools/staff.js create-root <email> "<Họ tên>"`
   It prints a temporary password.
5. Open http://localhost:4000, sign in, choose your own password.

Forgotten root password, or root locked out:
`docker compose exec api-gateway node dist/tools/staff.js reset-root`
(new temporary password, every root session ends). `staff.js list` shows the
staff accounts.

Without `ADMIN_API_KEY` the Console still starts and answers 503
`CONSOLE_NOT_CONFIGURED` with what to set; without `SIMULATOR_ADMIN_TOKEN` the
Simulator section is hidden (503 `SIMULATOR_NOT_CONFIGURED`).

## Pages

| Menu | Permission | Shows | Changes |
|---|---|---|---|
| **Vận hành** · Tổng quan | `overview.view` | Accounts (new today / 7 days, active 7 days, locked), devices and online, revenue this month (mock orders not counted), orders to look at, SePay transactions vs limit, assistant tokens; 30-day columns: new accounts, revenue, assistant tokens; devices per product, accounts per plan. Cached 60 s, refreshed every minute. | — |
| Tài khoản khách | `accounts.view` | Search by e-mail, name or device MAC; filters locked / paid plan. Detail: plan and usage, smart features, devices (owned and shared, online), open sessions, last orders, the account's admin log (with `audit.view`). | Lock / unlock, sign out everywhere (`accounts.manage`); give or extend a plan (`plans.gift`) |
| Thanh toán | `payments.view` | Orders part paid, waiting (7 days), paid; transfers no order matched (30 days); SePay counter. | Confirm money received, cancel an order (`payments.manage`) |
| Trợ lý | `assistant.view` | Tokens and turns this month by plan, today vs the system ceiling, per day, outcomes, voice vs text, 20 heaviest accounts. | — |
| Nhật ký | `audit.view` | Every change from the Console or the CLI, newest first, with reason and who did it; filter by action. | — |
| **Simulator** · Kiểm thử tải, Thiết bị ảo, Người dùng ảo, Xưởng sản xuất, Hệ thống Simulator | `simulator.view` | The former Simulator dashboard (`device-simulator/README.md`). With view only, a banner says that buttons will be refused. | Everything with `simulator.manage` |
| Thời tiết giả lập | `simulator.view` | The Gateway's weather mode; with `WEATHER_MODE=mock`, the weather set per province or "Mọi nơi" ([weather.md](weather.md)). Talks to the Gateway, so it works without a Simulator. | Set or clear (`simulator.manage`) |
| **Công ty** · Nhân viên | root | Staff, their permissions, last sign-in, status (active, locked, waiting for a new password). | Add (temporary password shown once), edit name and permissions, lock / unlock, reset password, sign out |
| Tài khoản của tôi | everyone | Own permissions and sessions. | Change password, sign out other sessions |

Deliberately **not** possible: reading assistant chats, camera or recordings,
access history, PINs or passwords; controlling customers' devices; deleting
accounts or editing their e-mail/name; changing prices or the catalog.

### Locking a customer account

`accounts.status = 'disabled'` (an existing state, no schema change):

- every session is revoked at once and realtime sockets are closed
  (`publishSessionsRevoked`); the open app is signed out on its next request;
- signing in again with the **right** password answers 403 `ACCOUNT_LOCKED`
  ("Tài khoản đã bị khóa. Vui lòng liên hệ hỗ trợ."); a wrong password still
  answers `INVALID_CREDENTIALS`, so a guesser learns nothing;
- the account's **smart features pause**: scene schedules and automations of
  this account do not act. The occurrence still passes (next time computed,
  state edge and event id recorded, no result written), so unlocking does not
  replay what happened meanwhile (`scenes/schedules.ts`, `automations/firing.ts`);
- **the house never freezes**: devices keep their own buttons, keypads and
  local safety rules, and people the devices are shared with keep using them
  (their own automations included).

Unlocking (`status = 'active'`) needs a new sign-in; schedules and automations
act again from their next occurrence. Staff cannot lock or unlock an account
that is pending deletion.

### Giving a plan

`POST /admin/accounts/:id/gift-plan {plan_code, days 1–366, reason}`, paid
plans only. Same rule as a purchase (`payments/service.ts extendPlan`): the
same active plan continues from its end; another plan starts now and converts
the remaining time at the two monthly prices. No order or revenue is created.
The customer's app gets the account event `plan_gifted` (snackbar, push
"Bạn được tặng gói trợ lý") and the assistant's memory notes it.

### Payments

The same functions as `node dist/tools/payments.js confirm|cancel`; the CLI
writes to the log too (actor "Lệnh CLI"). Confirming records a manual
transaction and pays or part-pays the order; cancelling tells the customer's app.

## The log

`admin_audit_log` keeps the actor kind (`staff` or `cli`), the staff member's
id and an e-mail snapshot (kept if the staff account is later changed), the
action, the customer account if any, the reason and details. Actions:
`account.disabled|enabled|signed_out`, `plan.gifted`,
`payment.confirmed|cancelled`, `staff.created|updated|disabled|enabled|password_reset|signed_out`
(the CLI's create-root and reset-root included), `simulator.request`
(method, path and status of each Simulator change; the webcam's video chunks
of virtual cameras are not logged) and `weather.mock_set|mock_cleared` (area
and scenario of the mock weather).

## API

Console (`admin-console/backend/src/app.ts`):

| Method | Path | |
|---|---|---|
| POST | `/api/session/login` | `{email, password}` → sets the cookie |
| POST | `/api/session/logout` | ends the session at the Gateway, clears the cookie |
| GET | `/api/session` | `{staff, simulator}` (who is signed in; is the Simulator connected) |
| any | `/api/admin/*` | forwarded to the Gateway `/admin/*` |
| any | `/api/simulator/*` | forwarded to the Simulator `/api/*` (permission checked here) |
| GET | `/api/health` | `{status, configured}` |

Gateway (all behind the guard; permission in brackets):

| Method | Path | |
|---|---|---|
| POST | `/admin/staff/login` | `{email, password}` → session token (only the Console calls it) |
| POST | `/admin/staff/logout` | [signed in] |
| GET | `/admin/staff/me` | [signed in] who am I |
| POST | `/admin/staff/me/password` | [signed in] `{current_password, new_password}` |
| GET | `/admin/staff/me/sessions` | [signed in] |
| POST | `/admin/staff/me/sessions/revoke-others` | [signed in] |
| GET | `/admin/permissions` | [signed in] permissions and presets |
| GET | `/admin/staff` | [root] |
| POST | `/admin/staff` | [root] `{email, full_name, permissions}` → `temporary_password` |
| PATCH | `/admin/staff/:id` | [root] `{full_name?, permissions?}` |
| POST | `/admin/staff/:id/disable` · `/enable` · `/reset-password` · `/sign-out` | [root] `{reason}` |
| GET | `/admin/overview` | [`overview.view`] (cache 60 s) |
| GET | `/admin/assistant` | [`assistant.view`] (cache 60 s) |
| GET | `/admin/plans` | [`plans.gift`] plans that can be given |
| GET | `/admin/accounts?q=&filter=all\|disabled\|paid&page=` | [`accounts.view`] 50 per page |
| GET | `/admin/accounts/:id` | [`accounts.view`] |
| POST | `/admin/accounts/:id/disable` · `/enable` · `/sign-out` | [`accounts.manage`] `{reason}` |
| POST | `/admin/accounts/:id/gift-plan` | [`plans.gift`] `{plan_code, days, reason}` |
| GET | `/admin/payments?tab=review\|pending\|paid\|unmatched&page=` | [`payments.view`] |
| POST | `/admin/payments/:code/confirm` | [`payments.manage`] `{amount_vnd?, reason}` |
| POST | `/admin/payments/:code/cancel` | [`payments.manage`] `{reason}` |
| GET | `/admin/audit?action=&account_id=&staff_id=&page=` | [`audit.view`] |
| POST | `/admin/audit/simulator` | [`simulator.manage`] the Console's log of a Simulator change |
| GET | `/admin/weather` | [`simulator.view`] weather mode, provinces, mock weather |
| PUT / DELETE | `/admin/weather/mock`, `/admin/weather/mock/:area` | [`simulator.manage`] set / clear mock weather (`409 WEATHER_NOT_MOCK` unless `WEATHER_MODE=mock`) |

## Data

- `212_admin.sql`: `admin_audit_log` with indexes by time and by account;
  indexes `accounts(created_at)` and paid `payment_orders(paid_at)` for the
  charts.
- `213_staff.sql` (additive): `staff_accounts` (e-mail, name, argon2 hash,
  `is_root` with a unique index for the single root, permissions `text[]`,
  status, temporary-password flag, failed sign-ins and lock time),
  `staff_sessions` (token hash, client, address, last use, expiry), and
  `admin_audit_log.staff_id` / `staff_email`.

## Load

The Console serves a handful of staff, not customers. With 8k accounts and
30k devices every query is indexed or scans a few thousand rows; lists are
paged (50); overview and assistant numbers are cached 60 s in Redis and
dropped after a change. A staff call costs one indexed session lookup
(`last_used_at` is written at most once a minute).

## Tests

- `api-gateway/test/admin.test.ts`: key, tunnel and "off" checks; root
  creation, temporary password, lockout after 5 wrong passwords, sessions;
  every permission against its routes and the root-only ones; staff
  management and its log; search by e-mail, name, MAC; lock → sessions
  revoked, `ACCOUNT_LOCKED`, schedules and automations pause, unlock resumes;
  gifts extend like purchases; confirm/cancel with log entries; assistant
  numbers without messages; the Simulator log entry.
- `admin-console/backend/test/console.test.ts`: cookie flags and the token
  never in a page; the header rule; keys added and cookies removed when
  forwarding; Simulator permission (view vs manage) and its log; binary bodies
  and event streams pass through; not configured / no Simulator.
