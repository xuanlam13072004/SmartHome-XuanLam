// lib/core/theme/color_scheme_ext.dart
//
// ThemeExtension chứa các màu Neumorphic custom (shadow pairs, surface)
// và semantic colors không có trong M3 ColorScheme mặc định.
//
// Truy cập: Theme.of(context).extension<NeuColors>()!
// Hoặc qua: context.neu (xem context_ext.dart)

import 'package:flutter/material.dart';
import '../tokens/app_colors.dart';
import '../tokens/app_shadows.dart';

/// ThemeExtension cho màu Neumorphic và semantic colors custom.
@immutable
class NeuColors extends ThemeExtension<NeuColors> {
  const NeuColors({
    required this.surface,
    required this.shadowDark,
    required this.shadowLight,
    required this.deviceOnline,
    required this.deviceOffline,
    required this.devicePending,
    required this.deviceError,
    required this.categoryLight,
    required this.categoryClimate,
    required this.categorySecurity,
    required this.categoryOutlet,
    required this.categorySensor,
    required this.categoryGeneric,
    required this.successColor,
    required this.warningColor,
  });

  // ── Neumorphic core ────────────────────────────────────────────────────────
  /// Màu nền Neumorphic (phải đồng nhất với container)
  final Color surface;

  /// Shadow tối (góc dưới-phải khi raised)
  final Color shadowDark;

  /// Shadow sáng (góc trên-trái khi raised)
  final Color shadowLight;

  // ── Device status ──────────────────────────────────────────────────────────
  final Color deviceOnline;
  final Color deviceOffline;
  final Color devicePending;
  final Color deviceError;

  // ── Category accents ──────────────────────────────────────────────────────
  final Color categoryLight;
  final Color categoryClimate;
  final Color categorySecurity;
  final Color categoryOutlet;
  final Color categorySensor;
  final Color categoryGeneric;

  // ── Misc semantic ─────────────────────────────────────────────────────────
  final Color successColor;
  final Color warningColor;

  // ── Shadow helpers ────────────────────────────────────────────────────────

  /// Raised mạnh — hero card, FAB
  NeuShadowStyle get raisedStrong => AppShadows.raisedStrong(
        darkShadow: shadowDark,
        lightShadow: shadowLight,
      );

  /// Raised thường — device card, button
  NeuShadowStyle get raisedMedium => AppShadows.raisedMedium(
        darkShadow: shadowDark,
        lightShadow: shadowLight,
      );

  /// Raised nhẹ — icon container, chip
  NeuShadowStyle get raisedSubtle => AppShadows.raisedSubtle(
        darkShadow: shadowDark,
        lightShadow: shadowLight,
      );

  /// Flat — inactive element
  NeuShadowStyle get flat => AppShadows.flat(
        darkShadow: shadowDark,
        lightShadow: shadowLight,
      );

  /// Pressed — active toggle, pressed button
  NeuShadowStyle get pressed => AppShadows.pressed(
        darkShadow: shadowDark,
        lightShadow: shadowLight,
      );

  // ── ThemeExtension lifecycle ───────────────────────────────────────────────

  @override
  NeuColors copyWith({
    Color? surface,
    Color? shadowDark,
    Color? shadowLight,
    Color? deviceOnline,
    Color? deviceOffline,
    Color? devicePending,
    Color? deviceError,
    Color? categoryLight,
    Color? categoryClimate,
    Color? categorySecurity,
    Color? categoryOutlet,
    Color? categorySensor,
    Color? categoryGeneric,
    Color? successColor,
    Color? warningColor,
  }) {
    return NeuColors(
      surface: surface ?? this.surface,
      shadowDark: shadowDark ?? this.shadowDark,
      shadowLight: shadowLight ?? this.shadowLight,
      deviceOnline: deviceOnline ?? this.deviceOnline,
      deviceOffline: deviceOffline ?? this.deviceOffline,
      devicePending: devicePending ?? this.devicePending,
      deviceError: deviceError ?? this.deviceError,
      categoryLight: categoryLight ?? this.categoryLight,
      categoryClimate: categoryClimate ?? this.categoryClimate,
      categorySecurity: categorySecurity ?? this.categorySecurity,
      categoryOutlet: categoryOutlet ?? this.categoryOutlet,
      categorySensor: categorySensor ?? this.categorySensor,
      categoryGeneric: categoryGeneric ?? this.categoryGeneric,
      successColor: successColor ?? this.successColor,
      warningColor: warningColor ?? this.warningColor,
    );
  }

  @override
  NeuColors lerp(NeuColors? other, double t) {
    if (other is! NeuColors) return this;
    return NeuColors(
      surface: Color.lerp(surface, other.surface, t)!,
      shadowDark: Color.lerp(shadowDark, other.shadowDark, t)!,
      shadowLight: Color.lerp(shadowLight, other.shadowLight, t)!,
      deviceOnline: Color.lerp(deviceOnline, other.deviceOnline, t)!,
      deviceOffline: Color.lerp(deviceOffline, other.deviceOffline, t)!,
      devicePending: Color.lerp(devicePending, other.devicePending, t)!,
      deviceError: Color.lerp(deviceError, other.deviceError, t)!,
      categoryLight: Color.lerp(categoryLight, other.categoryLight, t)!,
      categoryClimate: Color.lerp(categoryClimate, other.categoryClimate, t)!,
      categorySecurity:
          Color.lerp(categorySecurity, other.categorySecurity, t)!,
      categoryOutlet: Color.lerp(categoryOutlet, other.categoryOutlet, t)!,
      categorySensor: Color.lerp(categorySensor, other.categorySensor, t)!,
      categoryGeneric: Color.lerp(categoryGeneric, other.categoryGeneric, t)!,
      successColor: Color.lerp(successColor, other.successColor, t)!,
      warningColor: Color.lerp(warningColor, other.warningColor, t)!,
    );
  }

  // ── Preset instances ──────────────────────────────────────────────────────

  /// Bộ màu chế độ sáng
  static const NeuColors light = NeuColors(
    surface: AppPalette.neuSurfaceLight,
    shadowDark: AppPalette.neuShadowDarkLight,
    shadowLight: AppPalette.neuShadowLightLight,
    deviceOnline: AppPalette.deviceOnline,
    deviceOffline: AppPalette.deviceOffline,
    devicePending: AppPalette.devicePending,
    deviceError: AppPalette.deviceError,
    categoryLight: AppPalette.catLight,
    categoryClimate: AppPalette.catClimate,
    categorySecurity: AppPalette.catSecurity,
    categoryOutlet: AppPalette.catOutlet,
    categorySensor: AppPalette.catSensor,
    categoryGeneric: AppPalette.catGeneric,
    successColor: AppPalette.successGreen,
    warningColor: AppPalette.warningOrange,
  );

  /// Bộ màu chế độ tối
  static const NeuColors dark = NeuColors(
    surface: AppPalette.neuSurfaceDark,
    shadowDark: AppPalette.neuShadowDarkDark,
    shadowLight: AppPalette.neuShadowLightDark,
    deviceOnline: AppPalette.successGreenLight,
    deviceOffline: AppPalette.grey600,
    devicePending: AppPalette.warningOrange,
    deviceError: AppPalette.errorRedLight,
    categoryLight: Color(0xFFE6D84A),
    categoryClimate: Color(0xFF4DB6E0),
    categorySecurity: Color(0xFFBA68C8),
    categoryOutlet: Color(0xFF66BB6A),
    categorySensor: Color(0xFF4DD0E1),
    categoryGeneric: Color(0xFF90A4AE),
    successColor: AppPalette.successGreenLight,
    warningColor: AppPalette.warningOrange,
  );
}
