import 'package:flutter/foundation.dart';

class AppConfig {
  static const String _apiBaseUrl = String.fromEnvironment('API_BASE_URL');

  /// API Gateway address.
  ///
  /// - Phone on the same Wi-Fi: `--dart-define=API_BASE_URL=http://<IP máy tính>:3000`.
  /// - Android emulator without the define: `10.0.2.2`, the emulator's name
  ///   for the computer it runs on.
  /// - Web / desktop without the define: `localhost`.
  static String get baseUrl {
    if (_apiBaseUrl.isNotEmpty) return _apiBaseUrl;
    if (!kIsWeb && defaultTargetPlatform == TargetPlatform.android) {
      return 'http://10.0.2.2:3000';
    }
    return 'http://localhost:3000';
  }

  static const String wsUrl =
      String.fromEnvironment('WS_URL', defaultValue: '');

  static const _loopbackHosts = {'localhost', '127.0.0.1', '::1'};

  /// A development server publishes service URLs (camera video) as
  /// `localhost`, which on a phone or emulator is the phone itself. When the
  /// app reaches the API through another host, the service is on that same
  /// computer, so use that host. Real addresses are returned unchanged.
  static String reachableUrl(String url) {
    final target = Uri.tryParse(url);
    final api = Uri.tryParse(baseUrl);
    if (target == null || api == null) return url;
    if (!_loopbackHosts.contains(target.host) || _loopbackHosts.contains(api.host)) {
      return url;
    }
    return target.replace(host: api.host).toString();
  }

  /// Time zone of scene schedules (IANA name). The app is used in Viet Nam;
  /// override with --dart-define=APP_TIME_ZONE=… elsewhere.
  static const String timeZone =
      String.fromEnvironment('APP_TIME_ZONE', defaultValue: 'Asia/Ho_Chi_Minh');

  /// Shown in "Giới thiệu"; keep in step with `version:` in pubspec.yaml.
  static const String appVersion = '1.0.0';
}
