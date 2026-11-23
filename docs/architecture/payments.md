# Payments ("Gói dịch vụ" → Thanh toán)

Status: phase C implemented 2026-11-22 (schema **210**). Buys the assistant
plans of docs/architecture/assistant.md; no other feature depends on a plan.

## How money moves

```
app ─ POST /payments/orders {plan_code, months} ─▶ Gateway prices it (assistant_plans), code SHxxxxxxxx, 15 min
app ◀─ VietQR (built by the Gateway) + account, amount, note = code
user's banking app ── transfer (note = code) ──▶ receiving bank account
SePay (watches that account) ── POST /payments/sepay/webhook (HMAC or API key) ─▶ Gateway
Gateway: transaction stored once (SePay id) → order found by code → paid → account_plans extended
         → `payment_updated` to the open apps; the app also polls the order every 4 s
         → a line in the assistant's memory, so the next chat knows the plan changed
```

Two places start an order: Cá nhân → Gói dịch vụ (sheet, then the checkout
screen) and the assistant chat (after the user taps "Xác nhận" on a plan
offer; the QR and every status change appear in the conversation, see
docs/architecture/assistant.md → Plans in the chat). Both call the same API.

No payment gateway, no fee: VietQR (NAPAS 247 EMVCo payload, CRC-16) is
generated locally (`modules/payments/vietqr.ts`, tested byte for byte against
published examples); SePay FREE reports up to 50 transactions a month (more
are billed; the CLI shows the count and the Gateway logs a warning near it).

## Modes (`PAYMENT_MODE`, root `.env`)

| Mode | Use | Confirmation |
|---|---|---|
| `mock` (compose default) | development, demos | button "Giả lập đã thanh toán" (`POST /payments/orders/:code/simulate`, refused in other modes) |
| `bank` | real money | SePay webhook; by hand with the CLI |
| `off` | payments hidden | — |

`bank` needs `PAYMENT_BANK_BIN` (NAPAS BIN, e.g. 970422 MBBank, 970416 ACB),
`PAYMENT_BANK_ACCOUNT`, and for display `PAYMENT_ACCOUNT_NAME`,
`PAYMENT_BANK_NAME`. SePay: webhook URL
`https://<api hostname>/payments/sepay/webhook`, JSON, and either
**HMAC-SHA256** (`SEPAY_WEBHOOK_SECRET`; headers `X-SePay-Signature:
sha256=<hex of HMAC(timestamp + "." + raw body)>`, `X-SePay-Timestamp`, ±5
minutes) or **API Key** (`SEPAY_API_KEY`; `Authorization: Apikey <key>`).

## Rules

- **Price from the server only**: `assistant_plans.price_vnd` (1 month) and
  `price_12m_vnd` (12 months = 10 × monthly). A client amount is ignored.
- **One open QR per account**: a new order cancels the unpaid one.
- **Code** `SH` + 8 symbols from 32 (no 0/O/1/I): 40 random bits, found in a
  bank note even with dots, lower case or spaces added.
- **Matching** a notification: incoming (`transferType: in`), to the
  configured account (`accountNumber` or `subAccount`), code in `code` or the
  note. Every notification is stored once in `payment_transactions`
  (`UNIQUE (provider, provider_ref)`), so SePay retries are harmless.
  Outcomes: `paid`, `partial`, `already_paid`, `unmatched`, `other_account`,
  `outgoing`.
- **Part payments add up** (`received_vnd`; status `review`, the QR asks for
  the rest). **Late transfers are honoured**: the 15 minutes only retire the
  QR; money that arrives for an expired or replaced order still pays it.
- **Plan time** (`account_plans`, one row per account): the same plan
  continues from its current end (+1 or +12 calendar months); another plan
  starts now and the unused time of the old one is converted at the two
  monthly prices (seconds × old price / new price). Expired → free plan.
- **Records are kept** (orders and transactions are bookkeeping; deleting an
  account removes its orders, its transactions stay unlinked).
- **Reminders**: 3 days and 1 day before a paid plan ends, and once it has
  ended, as a snackbar in the open app and a push notification that opens the
  chat with a renewal offer (docs/architecture/push.md).

## Manual confirmation (CLI in the Gateway container)

```powershell
docker compose exec api-gateway node dist/tools/payments.js list
docker compose exec api-gateway node dist/tools/payments.js confirm SHABCD2345 [amount]
docker compose exec api-gateway node dist/tools/payments.js cancel SHABCD2345
```

`list`: open orders (7 days), transfers without a payable order (30 days),
SePay transactions this month. `confirm` records a manual transaction and
pays like the webhook (default amount: what is left). `confirm` and `cancel`
are also buttons on the Simulator's "Quản trị" page (docs/architecture/admin.md);
both ways write the change to `admin_audit_log` (actor `admin` or `cli`).

## API

| Route | Notes |
|---|---|
| `GET /payments/options` | mode, availability, purchasable plans with 1/12-month prices |
| `POST /payments/orders` `{plan_code, months: 1|12}` | 10/hour; returns the order with `transfer` (bank, account, amount, note, `qr`) in bank mode |
| `GET /payments/orders` | last 20 (not cancelled) |
| `GET /payments/orders/:code` | the app polls it; status `pending` · `expired` · `review` · `paid` · `cancelled` |
| `POST /payments/orders/:code/cancel` | pending only |
| `POST /payments/orders/:code/simulate` | mock mode only |
| `POST /payments/sepay/webhook` | SePay only; answers `{"success": true}` |

## Testing without spending

1. `PAYMENT_MODE=mock`: the whole flow in the app with the test button.
2. SePay **Test mode**: create a webhook there pointing to the tunnel URL and
   simulate transactions (no real account, no quota).
3. One real 10.000đ transfer to check the bank link, then `bank` mode.

## Tests

- `test/vietqr.test.ts`: CRC check value, payloads equal to published VietQR
  examples, order codes and finding them in bank notes.
- `test/payments.test.ts`: server pricing, QR content, HMAC (forged, replayed,
  valid), retried webhook, part and late payments, unmatched / other account /
  outgoing, renew and upgrade time, mock mode, manual confirmation, cancel,
  API key, disabled webhook, the payment line in the assistant memory.
- App: `test/payment_models_test.dart`, `test/assistant_models_test.dart` (chat messages).
