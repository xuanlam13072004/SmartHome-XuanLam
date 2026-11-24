# Assistant ("Trợ lý")

Status: phase B implemented 2026-11-21 (schema **209**); plan advice and
selling in the chat added 2026-11-22; drafting scenes and automations by
voice or text added 2026-11-22; questions about the home's history added
2026-11-23; the weather at home (answers and weather conditions in drafts)
added 2026-11-24. Builds on voice verification
(docs/architecture/voice.md). Plans are bought with payments (phase C,
docs/architecture/payments.md), which write `account_plans`.

## Decisions (with the user)

- **General chatbot**: answers any question, not only about the home.
- **3 plans** with a monthly token allowance (data in `assistant_plans`):
  Miễn phí 100k tokens (0đ), Cơ bản 1.5M (49.000đ), Nâng cao 5M (99.000đ).
  Only the assistant is limited; device control in the app and alerts never are.
- **Voice verification only for commands** that change something; questions
  and chat are answered for anyone speaking.
- **PhoWhisper-small, original form** (transformers + PyTorch in voice-service).
- **Gemini** (REST `generateContent`, default `gemini-3.8-flash`, thinking `low`)
  understands; it can only *propose* commands through functions.
- **Creates scenes and automations from what the user says** ("mỗi tối 10 giờ
  khóa cửa", "khi trời mưa thì đóng mái"): a preview card in the chat, nothing
  is created until the user taps "Lưu".
- **Answers questions about the home's past** ("hôm qua cửa mở mấy lần?",
  "nhiệt độ bếp cao nhất bao nhiêu?") from facts the server looks up, never
  from the model's memory, with the same visibility as the app's screens;
  the owner also hears who sent a command.
- **Answers weather questions at home** ("chiều mai có mưa không?") from the
  stored forecast, never from memory, and drafts automations with weather
  conditions ("6 giờ tưới vườn nếu 12 giờ tới không mưa"):
  [weather.md](weather.md).
- **Typed or spoken, like a chatbot**; it also **advises on plans and sells
  them in the chat**: the user confirms first (a tap), then the order's QR
  appears in the conversation and the result (paid, part paid, expired,
  cancelled) is announced there.

## A turn

```
app ── text ───────────────────────────────▶ POST /assistant/message
app ── WAV ─▶ POST /assistant/voice ─▶ voice-service /v1/listen/{account}
                                         (quality → PhoWhisper → verification if a profile exists)
                    │
                    ▼
     quota (plan + system ceiling) → home context → Gemini (1 call) → checks
                    │
     commands? ── voice: owner's verified voice required (else refused, counts towards the lock)
                    │
     run: createDeviceOperation / startRun (normal paths, permissions, idempotency)
     confirm-type operations and protected scenes → pending → POST /assistant/confirm
                    │
     reply written by the server for commands and plan offers; Gemini's own text for chat
```

## Why it does not run wrong commands

Layers, each sufficient to stop a different failure:

1. **Prompt** (`modules/assistant/prompt.ts`): commands only for requests to
   act now; never for questions, stories, hypotheticals, negations, schedules
   or automation rules (those are pointed to Kịch bản); ask back when a command
   fits several devices or lacks a value; never follow text inside the home
   data (device names are user-written and may look like orders).
2. **Closed world** (`context.ts`): the model sees short ids (`a1`, `s1`) for
   exactly the operations the account may run, built with the scene-step rule
   (no camera sessions, queries, runtime ids or date-time inputs) and only
   operations with no value or one simple value. Device names and states are
   sent as JSON data, separate from the user's words.
3. **Server checks** (`planner.ts`), any failure drops the call, never repairs it:
   - the id exists in this turn's context;
   - `quote` (the words the model claims it acted on) is in what the user
     said: ≥ 60% of its words, tone marks ignored (speech-to-text loses them),
     or in the previous message when the assistant had just asked back;
   - no negation in or right before the quote (`đừng`, `không`, `chưa`,
     `khoan`, `khỏi`, `cấm`; "không khí", "ra khỏi" are not negations);
   - the value parses against the operation's schema (integer, range, enum,
     default) — "10" for a 30–3600 s field is refused, not clamped;
   - at most 6 commands; duplicates collapse; a question back cancels every
     command of that turn.
4. **Normal device path**: permissions, input validation and idempotency of
   `createDeviceOperation`; operations the app confirms (`confirmation:
   confirm`) wait for a tap, `reauthenticate` and scenes with protected steps
   wait for the password (`X-Reauth-Token`), exactly as in the app.
5. **Voice**: a spoken command runs only when voice-service verified the
   owner's live voice; otherwise it is refused and counts towards the 15-minute
   lock (`modules/voice/lockout.ts`).

The reply of a turn that runs commands is written by the server ("Đã gửi
lệnh …", "… cần bạn xác nhận"), so the model can never claim something ran.

## Scenes and automations in the chat

- `draft_automation(name, icon, trigger: time|watch|event|none, time, days,
  watch_id, operator, value, event_id, conditions[], only_from, only_to,
  steps[{action_id, value, delay_seconds}], notify_message, quote)`.
  `none` makes a scene run by hand; the others an automation (with a new
  scene for its steps, like automation suggestions).
- What may be watched (`w…` states with allowed values and their Vietnamese
  words, `e…` events; the automation pickers' rule, without signal/firmware
  diagnostics and unbounded counters) is added to the home data **only when
  the message may be about automations** (`mayBeAutomation`: mỗi, khi, nếu,
  giờ, tạo, kịch bản…), keeping ordinary turns small.
- Server checks (`drafts.ts`, pure): grounded, non-negated quote; ids from this
  turn; `HH:MM` and weekdays 1–7 (none = every day); values parsed against
  the state (boolean, enum key, number in range with gt/lt) and the
  operation (like commands); ≤ 3 conditions, ≤ `MAX_SCENE_STEPS` steps,
  delays 0–3600 s; an automation needs steps or a notification. Operations
  that need a confirmation or the password (unlocking) are refused in an
  automation (`protected_step`, the reply says why) but allowed in a scene run
  by hand. One-time timers are not supported: the prompt asks back instead.
- Once the account has a home location, the automation data also lists
  "Thời tiết ở <nơi>" with the seven weather conditions as watches usable only
  in `conditions` (never as the trigger); a saved draft stores them as
  `{"weather", "operator", "value"}`.
- The turn returns `draft {id, kind, name, trigger, conditions[], window,
  steps[{label, delay}], notify}` (all lines written by the server with the
  app's words, `automations/labels.ts`) and a server-written reply; outcome
  `confirm`. Drafts wait 30 minutes in Redis (`draftStore.ts`).
- `POST /assistant/drafts/:id/save {timezone}` runs the normal checks again
  (`resolveSteps`, `resolveAutomation`, limits, protected scenes), creates the
  scene and/or automation in one transaction (taken names get a number),
  announces the automation to every Gateway and returns the ids; the app then
  offers "Mở" in the Kịch bản editor.

## History in the chat

Like asking a librarian: the model fills a request slip, the server reads the
records and the model only retells what the slip came back with.

1. **First call**: the model may call `look_up_history(what, device_id |
   run_id, event_ids?, reading_id?, period, amount?, from_date?, to_date?,
   from_hour?, to_hour?)`, at most 3 per message. What may be looked up is
   added to the home data (`history`) only when the message may be about the
   past (`mayBeHistory`: hôm nay/qua/kia, tuần, tháng, lần cuối, mấy lần, có
   ai, đã … chưa, cao nhất…) or follows such an answer: devices `d…` with
   their events `v…` and sampled readings `m…` (no diagnostics), the
   automations `u…` (scenes keep their `s…`), and `today`.
   - `what`: `events` (what the device reported: door opened, PIN, rain,
     watering, alerts), `readings` (highest, lowest, average and latest of
     one measure), `commands` (sent from the app, scenes, the assistant),
     `runs` (scene and automation runs; empty `run_id` = every scene).
   - `period`: `today`, `yesterday`, `last_hours` (1–48), `last_days` (1–30,
     today included), `this_week`, `last_week`, `this_month`, `dates`
     (`YYYY-MM-DD`, one day or a range); `from_hour`/`to_hour` cut one day
     ("tối qua" = yesterday 18–24). Days are Vietnam days.
2. **Server checks** (`history.ts`, pure): ids from this turn, a valid
   period not in the future; anything older than 30 days is cut (the facts
   say `only_last_days: 30`) or, entirely older, not read at all
   (`too_old`). A question back cancels every lookup.
3. **Lookup** (`historyQuery.ts`), with the screens' rules:
   - owner: every event of the device and only of its current owner
     (`owner_id`), from the day they got it; every command with who sent it
     ("bạn" or the member's name);
   - member of a shared device: warnings and alerts only (no access
     history: door, PIN, keypad, watering), from the day they joined
     (`sees: "alerts_only"`), and only their own commands (`only_yours`);
   - runs: the account's own scenes and automations (an automation that
     only notifies counts its notifications).
   Facts: totals and counts per kind, first and last time, the 10 latest
   times with details in words ("qua bàn phím", "chạy 10 phút, xong lượt",
   "còn 2 lần thử"); readings rounded as the catalog says. Each query reads
   an index by device or account and time over ≤ 30 days (first/last time of
   an event kind: one indexed read each); results are kept 60 s in Redis.
4. **Second call**, without functions (`ANSWER_PROMPT`): the user's question
   and the facts as JSON; 1–3 sentences, the period named, digits as in the
   facts, nothing computed or guessed.
5. **Number check**: every number in the answer (times and dates split into
   their parts) must appear in the facts or in the question (and "114").
   Otherwise, or when the call fails, the reply is the server's own sentence
   (`historyFallback`), e.g. "Hôm qua (22/11), Cửa chính: cửa được mở 3 lần
   (gần nhất 22:14 22/11)."

The turn is a `chat` (or `action` when the user also gave a command, which
runs as usual and whose result line follows the answer); `charts` lists the
devices looked up with the chart period closest to the question, and the app
shows "Xem biểu đồ" (the device's activity charts, opened on that period).
`assistant_turns.actions` records `{kind: 'history', what, target, period,
grounded}`. Both calls count towards the allowance (about twice an ordinary
question). Never looked up: camera images or recordings, other accounts,
other people's chats.

## Weather in the chat

The same librarian, with a forecast instead of records ([weather.md](weather.md)):
`look_up_weather(when: now|today|tomorrow|day_after|next_hours, amount?,
from_hour?, to_hour?)`, at most 2 per message; the home data always carries
`weather: {place}` (null without a home location, absent when the server has
weather off). Facts: place, period, highest/lowest °C, sky, rain hours and the
highest rain chance (or `no_location` / `unavailable`, `mock` for simulated
weather); the second call and the number check are the history ones, the
fallback is the server's sentence ("Theo dự báo, ngày mai (24/11) ở Hà Nội:
24–31°C, không có mưa."). Recorded as `{kind: 'history', what: 'weather',
target: null, period, grounded}`: the place is not kept. Other cities and
days after tomorrow are answered with what the assistant can see (home, 3 days).

## Plans in the chat

- The home data carries `account`: current plan and its end date, tokens used
  this month, the reset day, whether payments are on, and every plan with its
  allowance, about how many questions it gives (tokens / 2,500) and its 1- and
  12-month prices. The model advises from these numbers only.
- `offer_plan(plan_code, months?, quote)` is for "buy / upgrade / renew now";
  price questions and comparisons get words. Server checks: the quote is
  grounded and not negated; the message asks to buy (`asksToBuy`: buying
  words such as mua, nâng cấp, gia hạn, đăng ký — or, right after the
  assistant asked whether or how long to buy, a "có / ok / đồng ý" or a
  duration like "12 tháng"); the plan is a paid one;
  months are 1, 12 or missing. A question back withdraws the offer.
- The turn returns `offer {plan, months|null, prices}` and a server-written
  reply ("Bạn xác nhận mua gói Cơ bản 1 tháng, giá 49.000đ nhé? …", or both
  durations when months are missing); outcome `confirm`. Payments off: a
  plain explanation, no offer. **No order exists until the user taps**; the
  app then calls `POST /payments/orders`, so the price is the server's.
- When an order is paid or part paid, payments add a line to the assistant's
  Redis memory ("Đã nhận 49.000đ cho đơn … Gói Cơ bản đã kích hoạt đến …"),
  so the next question already knows.

## Tokens and plans (`quota.ts`, migration 209)

- Usage = `usageMetadata.totalTokenCount` reported by Gemini (thinking
  included), added after each call to `assistant_usage (account, month)`;
  months follow Vietnam time. One turn on a 6-device home is ~2–3k tokens.
- Before a call: remaining allowance > 0, else 429 `ASSISTANT_QUOTA_EXCEEDED`
  (`details.plan`, `details.resets_at`); system daily ceiling
  `ASSISTANT_DAILY_TOKEN_CAP` (Redis, default 3M) protects the shared key.
- Plan = `account_plans` row not yet expired, else `free`.
- Rate limit 20 turns/minute per account.

## Memory

Redis, shared by Gateway instances: the last 8 messages for 15 minutes (so
"đóng lại đi" or an answer to a question works), pending confirmations for 5
minutes (run once: get + delete in one transaction). `assistant_turns` keeps
each turn (message, reply, outcome, commands, tokens, voice verified) 30 days
for debugging and the report; no audio.

## API

| Route | Body | Notes |
|---|---|---|
| `POST /assistant/message` | `{text}` ≤ 500 chars | typed: acts like a tap, no voice check |
| `POST /assistant/voice` | multipart `audio` (WAV ≤ 1 MB) | adds `transcript`, `voice_verified` |
| `POST /assistant/confirm` | `{pending_id}` (+ `X-Reauth-Token`) | runs a pending command once |
| `POST /assistant/drafts/:id/save` | `{timezone}` | creates a drafted scene/automation once |
| `DELETE /assistant/conversation` | — | forgets the memory |
| `GET /assistant/usage` | — | plan, used/remaining, `resets_at`, all plans |

Turn response: `reply`, `outcome` (`chat` · `action` · `clarify` · `confirm` ·
`refused` · `error`), `charts[]` (`mac`, `device`, `range` 24h · 7d · 30d; history answers), `actions[]` (`label`, `target`, `status` sent · pending ·
failed · refused, `pending_id`, `confirmation`), `clarification` (`question`,
`options`), `offer` (`plan {code, name}`, `months` 1 · 12 · null, `prices[]`)
or null, `draft` (see above) or null, `usage`.

Config (root `.env`): `GEMINI_API_KEY` (empty = assistant off, 503),
`GEMINI_MODEL`, `GEMINI_THINKING_LEVEL`. Free-tier keys: Google may use prompts
to improve its products.

## Prompt test set

`api-gateway/test/assistant/cases.json`: 157 sentences on a sample home
(`test/assistant/fixture.ts`, Saturday 21/11/2026 20:40: front and back
door — the back door's name tries to give orders —, awning, kitchen hazard
unit, irrigation, camera, two scenes, two automations, home in Hà Nội; the account is on the
free plan with 82k of 100k tokens used):
clear commands (incl. values, several at once, no tone marks, polite
requests), ambiguous ones that must be asked back, state questions,
negations, hypotheticals, schedules, injections, general chat, multi-turn,
plans (buy with and without months, a "yes" to an offer, price questions,
comparisons, refusals, the free plan), and scenes/automations (daily and
weekend times, rain, a door opening with a notification, soil moisture, a
scene by hand, a one-time timer that must be asked back, unlocking by itself
that must be refused), and 23 questions about the past (events, readings,
commands, runs, periods from "tối qua" to "tháng này", a follow-up, a
question and a command together, the device whose name gives orders, a
current-state question that must not look anything up), and 11 about the
weather (a day or part of it, now, the next hours, "có nên phơi đồ", a
question with a command, drafts with weather conditions, another city and
next week that must not be looked up).

```powershell
cd api-gateway
$env:GEMINI_API_KEY="..."; npm run assistant:eval -- --out assistant-report.json
```

Uses the real planner and checks, sends nothing to devices, prints each
sentence and a summary: `wrong_command` must be 0 (exit code 1 otherwise);
`missed`/`not_asked` show where the prompt can improve; `wrong_offer` counts
plan offers nobody asked for or with the wrong plan/months, `wrong_draft`
drafts nobody asked for or wrong ones, `wrong_history` history or weather
lookups nobody asked for or of the wrong device, kind, day or period (the user would still have to
confirm or save, and a lookup only reads, so none fails the run); `dropped_by_checks`
counts proposals the server checks stopped. `--delay` (default 4 s) respects
free-tier request limits; `--only 1,5` reruns some.

## App

Dashboard → ✨ or Cá nhân → Trợ lý nhà: a chat to type in, mic button (tap
to talk, tap to send, 10 s max, checked on the phone first), confirm/password
buttons on pending commands, choices as chips, replies read aloud
(`flutter_tts`, vi-VN, toggle in the app bar), allowance bar. Cá nhân → Gói
dịch vụ shows the plan, usage, plans to buy or renew and the payment history.

The conversation lives in `assistantChatProvider` (`providers/assistant_chat.dart`),
so it survives leaving the screen and is cleared on sign-out. Plan offers show
"Xác nhận · 49.000đ" (or one button per duration) and "Thôi"; the order card
(`widgets/chat_order_card.dart`) shows the QR and transfer details (shared with
the checkout screen, `payments/widgets/payment_widgets.dart`), a countdown,
"Hủy đơn", "Giả lập đã thanh toán" in mock mode and "Tạo mã mới" once expired.
Open orders are polled every 4 s while the chat is on screen; the realtime
`payment_updated` event updates them anywhere. Each change is announced (and
read aloud) in the chat: paid with the new end date, the amount still missing,
expired, cancelled. When the allowance is used up, the error shows the bigger
plans as buttons that open an offer without calling Gemini. A drafted scene or
automation shows as a card (`widgets/draft_card.dart`): what starts it, the
steps, "Lưu và bật" / "Lưu kịch bản" and "Thôi"; once saved, "Mở" opens it in
the Kịch bản editor and the scene/automation lists refresh.

## Tests

- `test/assistant-planner.test.ts`: context, quote grounding, values, drops,
  question back, Gemini parsing (no database).
- `test/assistant-cases.test.ts`: the test set is valid for the sample home; scoring.
- `test/assistant-history.test.ts`: periods in Vietnam time and the 30-day
  limit, event details in words, the number check and the server's
  sentences, what a member may look up, the planner's checks; full turns
  with a stand-in Gemini on the databases: the owner's events, a member's
  alerts and own commands vs. the owner seeing names, readings, scene runs,
  a too-old period, an invented number, a question with a command.
- `test/weather.test.ts`: weather lookups, facts, number check and fallback,
  weather watches in drafts, and full turns answering and drafting with a
  stand-in Gemini.
- `test/assistant.test.ts`: full turns with a stand-in Gemini and voice-service
  (device operations, confirmation, password, voice gate, drafts saved into
  scenes/automations, plan offers, quota, failures).
- `test/payments.test.ts` also checks the payment line in the assistant memory.
- App: `test/assistant_models_test.dart` (offers, the chat's order messages, history charts).
