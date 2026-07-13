// lib/core/tokens/app_radius.dart
//
// Border radius tokens theo design system.
// Dùng: BorderRadius.circular(AppRadius.md)

abstract final class AppRadius {
  /// 4pt — chip nhỏ, tag
  static const double xs = 4.0;

  /// 8pt — button nhỏ, input
  static const double sm = 8.0;

  /// 12pt
  static const double smMd = 12.0;

  /// 16pt — card, modal
  static const double md = 16.0;

  /// 20pt
  static const double mdLg = 20.0;

  /// 24pt — card lớn, bottom sheet
  static const double lg = 24.0;

  /// 32pt — hero card
  static const double xl = 32.0;

  /// 100pt — pill / fully rounded
  static const double full = 100.0;
}
