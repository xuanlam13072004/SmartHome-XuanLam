# SmartHome app (Flutter)

Android, iOS and web. Tested toolchain: Flutter 3.27.1.

## Server address

The app talks to the API Gateway (port 3000) and the realtime service
(port 3001, path `/ws`). Camera video comes from the media relay (port 8090);
when the server publishes it as `localhost`, the app uses the API host instead
(`AppConfig.reachableUrl`).

| Where the app runs | Command |
|---|---|
| Phone, anywhere (Cloudflare Tunnel) | `flutter run --dart-define-from-file=config/cloudflare.json` |
| Android emulator | `flutter run` (uses `10.0.2.2`, the emulator's name for the computer) |
| Chrome | `flutter run -d chrome` (uses `localhost`) |
| Phone on the same Wi-Fi, by IP | `flutter run --dart-define=API_BASE_URL=http://<IP máy tính>:3000` (see below) |

`config/cloudflare.json` holds the tunnel hostnames (`API_BASE_URL`, `WS_URL`)
and `MEDIA_BASE_URL`, the private address of camera video
(`http://10.250.0.2:8090`). That address works only while the phone runs the
Cloudflare One Agent (WARP) enrolled in the project's Zero Trust organization;
without it everything but camera video still works. Setup:
`docs/cloudflare-tunnel.md`.

By IP on the LAN instead: set `PUBLISH_HOST=0.0.0.0` and `TRUST_PROXY=` in the
root `.env` (see `.env.example`), find the computer's IPv4 with `ipconfig` and
allow the ports through Windows Firewall once (PowerShell as Administrator):

```powershell
New-NetFirewallRule -DisplayName "SmartHome dev" -Direction Inbound -Protocol TCP -LocalPort 3000,3001,8090 -Action Allow -Profile Private
```

The Wi-Fi network must be set to Private in Windows.

## Release APK

```
flutter build apk --release --dart-define-from-file=config/cloudflare.json
```

The APK is in `build/app/outputs/flutter-apk/app-release.apk` (signed with the
debug key; fine for testing, not for a store).

## Android notes

- Toolchain: Gradle 8.12, Android Gradle Plugin 8.7.3, Kotlin 2.1.0, Java 17,
  minSdk 24 (`flutter_secure_storage` 10 needs 23). Building needs JDK 17+
  (the one bundled with Android Studio works).
- `usesCleartextTraffic="true"` lets the app use the development server over
  plain HTTP. Remove it when the server is served over HTTPS.
- Voice and assistant: `record` (16 kHz mono PCM, Android `voiceRecognition`
  source, `RECORD_AUDIO` / `NSMicrophoneUsageDescription`), `flutter_tts`
  (replies read aloud; the manifest declares the `TTS_SERVICE` query),
  `qr_flutter` (VietQR on the payment screen). `record` 6.1+ builds with Kotlin
  2.2: if Gradle complains about the Kotlin version, raise
  `org.jetbrains.kotlin.android` in `android/settings.gradle` to 2.2.x.
- Push notifications (`firebase_messaging`): put the Firebase project's
  `google-services.json` in `android/app/` (Git-ignored) to turn them on; the
  Google services plugin is applied only when that file exists, so the app
  builds without it. Channels `alerts` / `general` are created in
  `MainActivity.kt`. Setup and testing: `docs/architecture/push.md`.
- Camera: the web app plays HLS with hls.js; Android / iOS use `video_player`
  (ExoPlayer). Recordings are mapped to wall-clock time from
  `#EXT-X-PROGRAM-DATE-TIME` (`lib/features/camera/player/hls_playlist.dart`).

## Checks

```
flutter pub get
flutter analyze
flutter test
```
