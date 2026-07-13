// lib/core/extensions/context_ext.dart
//
// BuildContext extension methods — truy cập theme, colors, text styles
// một cách ngắn gọn mà không cần Theme.of(context).xxx mỗi lần.
//
// Dùng:
//   context.colorScheme.primary
//   context.textTheme.titleLarge
//   context.neu.raisedMedium
//   context.isLight / context.isDark

import 'package:flutter/material.dart';
import '../theme/color_scheme_ext.dart';

extension AppContextExt on BuildContext {
  // ── Theme core ────────────────────────────────────────────────────────────

  /// ThemeData đầy đủ
  ThemeData get theme => Theme.of(this);

  /// M3 ColorScheme
  ColorScheme get colorScheme => Theme.of(this).colorScheme;

  /// TextTheme
  TextTheme get textTheme => Theme.of(this).textTheme;

  // ── Neumorphic extension ──────────────────────────────────────────────────

  /// NeuColors — bộ màu Neumorphic + semantic colors
  NeuColors get neu => Theme.of(this).extension<NeuColors>()!;

  // ── Brightness helpers ────────────────────────────────────────────────────

  /// true nếu đang ở light mode
  bool get isLight => Theme.of(this).brightness == Brightness.light;

  /// true nếu đang ở dark mode
  bool get isDark => Theme.of(this).brightness == Brightness.dark;

  // ── Media query helpers ───────────────────────────────────────────────────

  /// Kích thước màn hình
  Size get screenSize => MediaQuery.sizeOf(this);

  /// Chiều rộng màn hình
  double get screenWidth => MediaQuery.sizeOf(this).width;

  /// Chiều cao màn hình
  double get screenHeight => MediaQuery.sizeOf(this).height;

  /// Padding system (safe area)
  EdgeInsets get viewPadding => MediaQuery.viewPaddingOf(this);

  /// Padding bottom (home indicator)
  double get bottomPadding => MediaQuery.viewPaddingOf(this).bottom;

  /// Padding top (status bar / notch)
  double get topPadding => MediaQuery.viewPaddingOf(this).top;

  // ── Color shortcuts ───────────────────────────────────────────────────────

  Color get primaryColor => colorScheme.primary;
  Color get onPrimaryColor => colorScheme.onPrimary;
  Color get surfaceColor => colorScheme.surface;
  Color get onSurfaceColor => colorScheme.onSurface;
  Color get onSurfaceVariantColor => colorScheme.onSurfaceVariant;
  Color get errorColor => colorScheme.error;
  Color get outlineColor => colorScheme.outline;

  // ── Text style shortcuts ──────────────────────────────────────────────────

  TextStyle? get displayLarge => textTheme.displayLarge;
  TextStyle? get headlineLarge => textTheme.headlineLarge;
  TextStyle? get headlineMedium => textTheme.headlineMedium;
  TextStyle? get headlineSmall => textTheme.headlineSmall;
  TextStyle? get titleLarge => textTheme.titleLarge;
  TextStyle? get titleMedium => textTheme.titleMedium;
  TextStyle? get titleSmall => textTheme.titleSmall;
  TextStyle? get bodyLarge => textTheme.bodyLarge;
  TextStyle? get bodyMedium => textTheme.bodyMedium;
  TextStyle? get bodySmall => textTheme.bodySmall;
  TextStyle? get labelLarge => textTheme.labelLarge;
  TextStyle? get labelMedium => textTheme.labelMedium;
  TextStyle? get labelSmall => textTheme.labelSmall;
}
