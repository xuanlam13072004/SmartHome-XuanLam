// lib/core/tokens/app_spacing.dart
//
// Hệ thống spacing theo 4pt grid.
// Dùng: SizedBox(height: AppSpacing.md), EdgeInsets.all(AppSpacing.lg)

abstract final class AppSpacing {
  static const double _base = 4.0;

  /// 4pt
  static const double xs = _base * 1;   // 4

  /// 8pt
  static const double sm = _base * 2;   // 8

  /// 12pt
  static const double smMd = _base * 3; // 12

  /// 16pt — default padding
  static const double md = _base * 4;   // 16

  /// 20pt
  static const double mdLg = _base * 5; // 20

  /// 24pt
  static const double lg = _base * 6;   // 24

  /// 32pt
  static const double xl = _base * 8;   // 32

  /// 40pt
  static const double xlXxl = _base * 10; // 40

  /// 48pt
  static const double xxl = _base * 12; // 48

  /// 64pt
  static const double xxxl = _base * 16; // 64
}
