# SmartHome app (Flutter)

Android, iOS and web. Tested toolchain: Flutter 3.27.1.

## Server address

The app talks to the API Gateway (port 3000) and the realtime service
(port 3001, derived from the same host). Camera video comes from the media
relay (port 8090); when the server publishes it as `localhost`, the app uses
the API host instead (`AppConfig.reachableUrl`).

| Where the app runs | Command |
|---|---|
| Android emulator | `flutter run` (uses `10.0.2.2`, the emulator's name for the computer) |
| Phone on the same Wi-Fi | `flutter run --dart-define=API_BASE_URL=http://<IP máy tính>:3000` |
| Chrome | `flutter run -d chrome` (uses `localhost`) |

For a phone, find the computer's IPv4 with `ipconfig` and allow ports 3000,
3001 and 8090 through Windows Firewall once (PowerShell as Administrator):

```powershell
New-NetFirewallRule -DisplayName "SmartHome dev" -Direction Inbound -Protocol TCP -LocalPort 3000,3001,8090 -Action Allow -Profile Private
```

The Wi-Fi network must be set to Private in Windows.

## Release APK

```
flutter build apk --release --dart-define=API_BASE_URL=http://<IP máy tính>:3000
```

The APK is in `build/app/outputs/flutter-apk/app-release.apk` (signed with the
debug key; fine for testing, not for a store).

## Android notes

- Toolchain: Gradle 8.12, Android Gradle Plugin 8.7.3, Kotlin 2.1.0, Java 17,
  minSdk 24 (`flutter_secure_storage` 10 needs 23). Building needs JDK 17+
  (the one bundled with Android Studio works).
- `usesCleartextTraffic="true"` lets the app use the development server over
  plain HTTP. Remove it when the server is served over HTTPS.
- Camera: the web app plays HLS with hls.js; Android / iOS use `video_player`
  (ExoPlayer). Recordings are mapped to wall-clock time from
  `#EXT-X-PROGRAM-DATE-TIME` (`lib/features/camera/player/hls_playlist.dart`).

## Checks

```
flutter pub get
flutter analyze
flutter test
```
