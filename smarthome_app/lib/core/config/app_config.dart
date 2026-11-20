import 'package:flutter/foundation.dart';

class AppConfig {
  static const String _apiBaseUrl = String.fromEnvironment('API_BASE_URL');

  /// API Gateway address.
  ///
  /// - Anywhere, through Cloudflare Tunnel:
  ///   `--dart-define-from-file=config/cloudflare.json` (also sets WS_URL).
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

  /// Where this phone reaches camera video, when that differs from what the
  /// server publishes: through Cloudflare Tunnel video takes the private
  /// route `http://10.250.0.2:8090`, open only with Cloudflare WARP on
  /// (docs/cloudflare-tunnel.md). Set by `config/cloudflare.json`.
  static const String _mediaBaseUrl = String.fromEnvironment('MEDIA_BASE_URL');

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

  /// A camera video URL from the server, made reachable from this phone:
  /// MEDIA_BASE_URL's scheme, host and port when set, else [reachableUrl].
  static String mediaUrl(String url) {
    final base = Uri.tryParse(_mediaBaseUrl);
    final target = Uri.tryParse(url);
    if (_mediaBaseUrl.isEmpty || base == null || target == null || !base.hasAuthority) {
      return reachableUrl(url);
    }
    return target.replace(scheme: base.scheme, host: base.host, port: base.port).toString();
  }

  /// Time zone of scene schedules (IANA name). The app is used in Viet Nam;
  /// override with --dart-define=APP_TIME_ZONE=… elsewhere.
  static const String timeZone =
      String.fromEnvironment('APP_TIME_ZONE', defaultValue: 'Asia/Ho_Chi_Minh');

  /// Shown in "Giới thiệu"; keep in step with `version:` in pubspec.yaml.
  static const String appVersion = '1.0.0';
}
