# Push notifications ("Thông báo đẩy")

Status: implemented 2026-11-22 (schema **211**). Without Firebase configured
everything still works; alerts then only reach phones with the app open.

## Why

Alerts travelled only over the realtime WebSocket, so a phone with the app
closed (or asleep for long) never heard about gas in the kitchen. Push
notifications go through Firebase Cloud Messaging (FCM, free) and appear on the
lock screen.

## What is pushed

| Source | Push | Opens | Android channel |
|---|---|---|---|
| Device event, severity warning/critical | title = alert ("Khí gas vượt ngưỡng"), body = device name | `/device/<mac>` | `alerts` if critical, safety or security; else `general` |
| Automation "gửi thông báo" | its title and body | `/profile/notifications` | `general` |
| Security notice (voice lock) | "Cảnh báo bảo mật" | `/profile/voice` | `alerts` |
| Payment paid / part paid | "Thanh toán thành công" / "Đã nhận một phần thanh toán" | `/profile/plans` | `general` |
| Sharing invitation / accepted | "Lời mời dùng chung thiết bị" … | `/profile/sharing` | `general` |
| Plan ends in 3 days, 1 day, has ended | "Gói trợ lý sắp hết hạn" / "đã hết hạn" | `/assistant?renew=<plan>` (chat with a renewal offer) | `general` |

Device alerts follow the notification center rules: every active member of the
device, minus muted categories ("Loại thông báo"); **safety cannot be muted**.
Scene progress and other chatter are not pushed. The same alert of the same
device is pushed at most once per `PUSH_EVENT_THROTTLE_SECONDS` (60 s); the
notification center still lists every event.

## How

```
mqtt-worker ─ device.event ─┐                       ┌─ realtime-service → open apps (unchanged)
Gateway ──── account.event ─┴─ Redis pub/sub ───────┤
                                                    └─ Gateway PushNotifier → FCM HTTP v1 → phones
```

- `workers/pushNotifier.ts` listens to the same Redis channels as the realtime
  service. Every Gateway instance receives every publication; `SET NX` on a
  hash of the message lets exactly one send. Informational device events are
  skipped before parsing. At most 500 messages in flight (a flood is dropped
  with a warning, never queued without bound).
- `modules/push/fcm.ts`: FCM v1 with an OAuth token the Gateway signs itself
  (RS256 JWT from the service account, cached ~1 h), no Firebase SDK. Tokens
  FCM rejects for good (`UNREGISTERED`, 404, sender mismatch) are deleted; one
  retry on 401/429/5xx.
- `push_tokens` (migration 211): one row per phone, **tied to the session**
  that registered it. Only phones of active sessions receive, so signing out,
  "sign out other sessions", a password change or an expired session stop the
  pushes at once. Max 10 phones per account; a phone signed in to another
  account moves to it.
- Plan reminders (`modules/payments/reminders.ts`, every 5 minutes in the scene
  runner): stages `3d`, `1d`, `expired` (only within a day of the end), one row
  per (account, end date, stage) in `plan_reminders`, so each goes out once
  even with several Gateways; renewing moves the end date and starts a new
  round. Published as `plan_expiring` / `plan_expired` account events (open
  apps show a snackbar with "Gia hạn"; the push notifier sends them to phones).
- A plan given by the company (`plan_gifted`, docs/architecture/admin.md):
  "Bạn được tặng gói trợ lý", opens Gói dịch vụ.

## API

| Route | Body | Notes |
|---|---|---|
| `PUT /me/push-tokens` | `{token, platform: android\|ios}` | registers this phone for the current session; returns `push_enabled` (server configured) |
| `DELETE /me/push-tokens` | `{token}` | before signing out |
| `POST /me/push-tokens/test` | — | "Thông báo thử" to the account's phones; 503 `PUSH_UNAVAILABLE`, 409 `PUSH_NO_DEVICE` |

## App

- `lib/features/push/push_notifications.dart` (`pushNotificationsProvider`):
  started by the app shell after sign-in (asks permission once — Android 13+
  and iOS show a dialog), registers the token, follows token changes, opens the
  route of a tapped notification (allow-listed screens only). While the app is
  open, incoming pushes are ignored: the realtime connection already shows a
  snackbar. Signing out unregisters the phone and deletes its token.
- Cá nhân → Loại thông báo shows the state (on, off in the phone settings,
  server not configured, this build without Firebase) and "Gửi thông báo thử".
- Android: channels `alerts` (high importance) and `general` are created in
  `MainActivity.kt`; white house status-bar icon `ic_stat_notify`, teal accent.
  `POST_NOTIFICATIONS` permission. The Google services Gradle plugin is applied
  only when `android/app/google-services.json` exists, so builds without
  Firebase keep working.

## Setting up Firebase (once)

1. <https://console.firebase.google.com> → Add project (Analytics not needed).
2. **Android app**: Project settings → Add app → Android, package name
   `com.smarthome.smarthome_app` → download `google-services.json` into
   `smarthome_app/android/app/` (Git-ignored), then rebuild the app.
3. **Server**: Project settings → Service accounts → Generate new private key →
   save it as `secrets/firebase-service-account.json` (Git-ignored, mounted
   read-only into the Gateway) → `docker compose up -d api-gateway`.
   The log says "Push notifications are on".
4. In the app: Cá nhân → Loại thông báo → "Gửi thông báo thử".
5. iOS (needs a Mac and an Apple Developer account): add an iOS app in Firebase
   (bundle id from Xcode), put `GoogleService-Info.plist` in `ios/Runner`,
   upload an APNs key in Firebase → Cloud Messaging, enable the Push
   Notifications capability in Xcode. Deployment target is iOS 13.

The service account file is a secret (it can send to every user). Keep it
out of Git and chat; replace it in the Firebase console if it leaks.

## Tests

- `api-gateway/test/push.test.ts`: every warning/critical catalog event has a
  Vietnamese title; message mapping; a stand-in FCM that checks the Gateway's
  RS256 assertion; members and muted categories; one send across Gateways;
  throttle; dead tokens deleted; a signed-out session stops receiving; test
  push; push off; plan reminders once per stage and a new round after renewal.
- App: `test/push_test.dart` (plan reminder events, renewal route).
