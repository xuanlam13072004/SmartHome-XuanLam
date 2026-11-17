import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Per-device app settings. Not secrets, kept across sign-out.
class LocalPreferences {
  const LocalPreferences({
    FlutterSecureStorage storage = const FlutterSecureStorage(),
  }) : _storage = storage;

  final FlutterSecureStorage _storage;

  static const String _themeModeKey = 'PREF_THEME_MODE';

  /// The app looked light-only before this setting existed; keep that default.
  static const ThemeMode defaultThemeMode = ThemeMode.light;

  Future<ThemeMode> readThemeMode() async {
    try {
      final stored = await _storage.read(key: _themeModeKey);
      return ThemeMode.values.firstWhere(
        (mode) => mode.name == stored,
        orElse: () => defaultThemeMode,
      );
    } catch (_) {
      return defaultThemeMode;
    }
  }

  Future<void> writeThemeMode(ThemeMode mode) =>
      _storage.write(key: _themeModeKey, value: mode.name);
}
