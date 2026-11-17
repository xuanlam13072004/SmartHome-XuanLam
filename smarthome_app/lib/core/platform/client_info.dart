import 'package:flutter/foundation.dart';

/// How this app introduces itself at sign-in; shown in "Phiên đăng nhập".
abstract final class ClientInfo {
  static Map<String, String> current() {
    final os = switch (defaultTargetPlatform) {
      TargetPlatform.android => 'Android',
      TargetPlatform.iOS => 'iOS',
      TargetPlatform.windows => 'Windows',
      TargetPlatform.macOS => 'macOS',
      TargetPlatform.linux => 'Linux',
      TargetPlatform.fuchsia => 'Fuchsia',
    };
    if (kIsWeb) return {'platform': 'web', 'name': 'Trình duyệt web · $os'};
    final platform = switch (defaultTargetPlatform) {
      TargetPlatform.android => 'android',
      TargetPlatform.iOS => 'ios',
      TargetPlatform.windows => 'windows',
      TargetPlatform.macOS => 'macos',
      TargetPlatform.linux => 'linux',
      TargetPlatform.fuchsia => 'unknown',
    };
    return {'platform': platform, 'name': 'Ứng dụng SmartHome · $os'};
  }
}
