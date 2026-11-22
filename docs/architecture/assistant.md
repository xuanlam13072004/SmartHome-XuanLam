# Assistant ("Trợ lý")

Status: phase B implemented 2026-11-21 (schema **209**). Builds on voice
verification (docs/architecture/voice.md). Payments (phase C) will write
`account_plans`.

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
     reply written by the server for commands; Gemini's own text for chat
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
| `DELETE /assistant/conversation` | — | forgets the memory |
| `GET /assistant/usage` | — | plan, used/remaining, `resets_at`, all plans |

Turn response: `reply`, `outcome` (`chat` · `action` · `clarify` · `confirm` ·
`refused` · `error`), `actions[]` (`label`, `target`, `status` sent · pending ·
failed · refused, `pending_id`, `confirmation`), `clarification` (`question`,
`options`), `usage`.

Config (root `.env`): `GEMINI_API_KEY` (empty = assistant off, 503),
`GEMINI_MODEL`, `GEMINI_THINKING_LEVEL`. Free-tier keys: Google may use prompts
to improve its products.

## Prompt test set

`api-gateway/test/assistant/cases.json`: 103 sentences on a sample home
(`test/assistant/fixture.ts`: front and back door — the back door's name tries
to give orders —, awning, kitchen hazard unit, irrigation, camera, two scenes):
clear commands (incl. values, several at once, no tone marks, polite
requests), ambiguous ones that must be asked back, state questions,
negations, hypotheticals, schedules, injections, general chat and multi-turn.

```powershell
cd api-gateway
$env:GEMINI_API_KEY="..."; npm run assistant:eval -- --out assistant-report.json
```

Uses the real planner and checks, sends nothing to devices, prints each
sentence and a summary: `wrong_command` must be 0 (exit code 1 otherwise);
`missed`/`not_asked` show where the prompt can improve; `dropped_by_checks`
counts proposals the server checks stopped. `--delay` (default 4 s) respects
free-tier request limits; `--only 1,5` reruns some.

## App

Dashboard → ✨ or Cá nhân → Trợ lý nhà: chat, mic button (tap to talk, tap
to send, 10 s max, checked on the phone first), confirm/password buttons on
pending commands, choices as chips, replies read aloud (`flutter_tts`,
vi-VN, toggle in the app bar), allowance bar. Cá nhân → Gói dịch vụ shows the
plan, usage and plans (upgrading arrives with payments).

## Tests

- `test/assistant-planner.test.ts`: context, quote grounding, values, drops,
  question back, Gemini parsing (no database).
- `test/assistant-cases.test.ts`: the test set is valid for the sample home; scoring.
- `test/assistant.test.ts`: full turns with a stand-in Gemini and voice-service
  (device operations, confirmation, password, voice gate, quota, failures).
