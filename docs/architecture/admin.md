# Administration ("Quản trị")

Status: implemented 2026-11-23.

The company's page for system numbers and customer support. It lives in the
Device Simulator dashboard (menu **Quản trị**), the tool the operator already
runs; customers never see it. There is one operator (the project owner), so
there are no admin accounts or roles: whoever runs the Simulator is the admin.
Named staff with limited rights (for example "only plans") can be added later;
the log already records who acted (`actor`).

## Who can reach it

```
Browser ──(Simulator ADMIN_TOKEN)──▶ Simulator backend ──(ADMIN_API_KEY, Docker network)──▶ API Gateway /admin/*
```

1. **Simulator token**: every `/api` call of the dashboard needs the Simulator's
   `ADMIN_TOKEN` (unchanged).
2. **Server key**: the Simulator backend forwards `/api/admin/*` to the Gateway's
   `/admin/*` and adds `X-Admin-Key: ADMIN_API_KEY`. The key stays on the two
   servers; the browser never receives it. Only `GET`/`POST` and paths
   `/admin/<1–3 segments>` are forwarded (`device-simulator/backend/src/api/admin-proxy.ts`).
3. **Gateway guard** (`api-gateway/src/modules/admin/guard.ts`, an `onRequest`
   hook on every admin route, before input validation):
   - `ADMIN_API_KEY` empty → the API does not exist (404);
   - request carrying Cloudflare headers (`cf-ray`, `cf-connecting-ip`) → 403
     `ADMIN_INTERNAL_ONLY`: the API is never reachable from the Internet, only
     inside the Docker network (`API_GATEWAY_URL=http://api-gateway:3000`);
   - wrong key → 401 `ADMIN_KEY_INVALID`, constant-time comparison, at most 20
     wrong keys per minute per address.
   A customer's access token is never accepted on `/admin`.
4. **Reason**: every change asks for a reason (3–300 characters), written to
   `admin_audit_log` in the same transaction as the change.

### Setting it up

Create one random key and put the same value in two files (both Git-ignored):

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

- root `.env`: `ADMIN_API_KEY=<key>` → `docker compose up -d api-gateway`
- `device-simulator/.env.docker`: `ADMIN_API_KEY=<key>` → `docker compose up -d` in `device-simulator/`

If something is missing the page says which side (`ADMIN_NOT_CONFIGURED`,
Gateway 404, `ADMIN_KEY_INVALID`, `ADMIN_INTERNAL_ONLY`).

## What the page shows and does

| Tab | Shows | Changes |
|---|---|---|
| Tổng quan | Accounts (new today / 7 days, active 7 days, locked), devices and online, revenue this month (mock orders not counted), orders to look at, SePay transactions vs limit, assistant tokens; 30-day columns: new accounts, revenue, assistant tokens; devices per product, accounts per plan. Cached 60 s, refreshed every minute. | — |
| Tài khoản | Search by email, name or device MAC; filters locked / paid plan. Detail: plan and usage, smart features (scenes, schedules, automations), devices (owned and shared, online), open sessions, last orders, admin log of the account. | Lock / unlock, sign out everywhere, give or extend a plan |
| Thanh toán | Orders part paid, waiting (7 days), paid; transfers no order matched (30 days); SePay counter. | Confirm money received (amount), cancel an order |
| Trợ lý | Tokens and turns this month by plan, today vs the system ceiling, turns and tokens per day, outcomes (chat, action, clarify, confirm, refused, error), voice vs text, 20 heaviest accounts. | — |
| Nhật ký | Every change from this page or the CLI, newest first, with reason, filter by action. | — |

Deliberately **not** possible: reading assistant chats, camera or recordings,
access history, PINs or passwords; controlling devices; deleting accounts or
editing their e-mail/name; changing prices or the catalog.

### Locking an account

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

The same functions as `node dist/tools/payments.js confirm|cancel`; the CLI now
also writes to the log with actor `cli`. Confirming records a manual
transaction and pays or part-pays the order; cancelling tells the customer's app.

## API (Gateway, all behind the guard)

| Method | Path | |
|---|---|---|
| GET | `/admin/overview` | Tổng quan (cache 60 s) |
| GET | `/admin/assistant` | Trợ lý (cache 60 s) |
| GET | `/admin/plans` | Plans that can be given |
| GET | `/admin/accounts?q=&filter=all\|disabled\|paid&page=` | 50 per page, newest first |
| GET | `/admin/accounts/:id` | Detail |
| POST | `/admin/accounts/:id/disable` · `/enable` · `/sign-out` | `{reason}` |
| POST | `/admin/accounts/:id/gift-plan` | `{plan_code, days, reason}` |
| GET | `/admin/payments?tab=review\|pending\|paid\|unmatched&page=` | |
| POST | `/admin/payments/:code/confirm` | `{amount_vnd?, reason}` (default: what is still owed) |
| POST | `/admin/payments/:code/cancel` | `{reason}` |
| GET | `/admin/audit?action=&account_id=&page=` | |

## Data

Migration `212_admin.sql` (additive): `admin_audit_log` (actor, action,
target account and e-mail snapshot, reason, details JSON, time) with indexes by
time and by account; indexes `accounts(created_at)` and paid
`payment_orders(paid_at)` for the charts.

## Load

With 8k accounts and 30k devices every query is indexed or scans a few
thousand rows; lists are paged (50); overview and assistant numbers are cached
60 s in Redis and dropped after a change. One operator uses the page, so it
adds nothing noticeable to the customers' traffic.

## Tests

- `api-gateway/test/admin.test.ts`: key, tunnel and "off" checks; search by
  e-mail, name, MAC; lock → sessions revoked, `ACCOUNT_LOCKED`, schedules and
  automations pause, unlock resumes; sign-out; gifts extend like purchases and
  notify; confirm/cancel with log entries; assistant numbers without messages.
- `device-simulator/backend/test/admin-proxy.test.ts`: key added, only
  `/admin` paths, Gateway answers passed through, unreachable Gateway.
