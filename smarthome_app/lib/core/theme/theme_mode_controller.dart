import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../storage/local_preferences.dart';

final localPreferencesProvider =
    Provider<LocalPreferences>((ref) => const LocalPreferences());

/// The stored theme, read in `main()` before the first frame and injected
/// with `overrideWithValue`, so the app never flashes the wrong theme.
final initialThemeModeProvider =
    Provider<ThemeMode>((ref) => LocalPreferences.defaultThemeMode);

final themeModeProvider =
    NotifierProvider<ThemeModeController, ThemeMode>(ThemeModeController.new);

class ThemeModeController extends Notifier<ThemeMode> {
  @override
  ThemeMode build() => ref.watch(initialThemeModeProvider);

  Future<void> select(ThemeMode mode) async {
    if (mode == state) return;
    state = mode;
    await ref.read(localPreferencesProvider).writeThemeMode(mode);
  }
}

extension ThemeModeLabel on ThemeMode {
  String get label => switch (this) {
        ThemeMode.light => 'Sáng',
        ThemeMode.dark => 'Tối',
        ThemeMode.system => 'Theo hệ thống',
      };
}
