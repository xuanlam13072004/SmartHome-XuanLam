// lib/core/tokens/app_colors.dart
//
// Raw color palette & semantic color aliases cho SmartHome XuanLam.
// Không import file này trực tiếp trong UI — dùng qua ThemeExtension (NeuColors).
//
// Hallmark Redesign: Premium Neumorphic — softer shadows, glow accents.

import 'package:flutter/material.dart';

/// Bảng màu raw — chỉ dùng nội bộ trong core/theme.
abstract final class AppPalette {
  // ── Neumorphic base surfaces ──────────────────────────────────────────────
  /// Nền chính chế độ sáng (warm off-white)
  static const Color neuSurfaceLight = Color(0xFFEEF0F5);

  /// Nền chính chế độ tối
  static const Color neuSurfaceDark = Color(0xFF1E2028);

  // ── Shadow pairs (light source: top-left) ─────────────────────────────────
  // Hallmark: Giảm opacity ~30% so với bản cũ → mềm mại, premium hơn.
  /// Bóng tối chế độ sáng (~50% opacity, was 70%)
  static const Color neuShadowDarkLight = Color(0x80A8B0BE);

  /// Bóng sáng chế độ sáng (~85% opacity, was 90%)
  static const Color neuShadowLightLight = Color(0xD9FFFFFF);

  /// Bóng tối chế độ tối (~35% opacity, was 50%)
  static const Color neuShadowDarkDark = Color(0x59000000);

  /// Bóng sáng chế độ tối (~60% opacity, was 80%)
  static const Color neuShadowLightDark = Color(0x992A2D3A);

  // ── Brand / Accent ────────────────────────────────────────────────────────
  /// Màu chủ đạo (teal xanh ngọc)
  static const Color primaryTeal = Color(0xFF00B4A6);
  static const Color primaryTealDark = Color(0xFF009E91);
  static const Color primaryTealLight = Color(0xFF4DD0C8);

  /// Màu phụ (cam vàng)
  static const Color secondaryAmber = Color(0xFFF5A623);
  static const Color secondaryAmberDark = Color(0xFFD4891A);
  static const Color secondaryAmberLight = Color(0xFFF7BB54);

  /// Màu lỗi
  static const Color errorRed = Color(0xFFE53935);
  static const Color errorRedLight = Color(0xFFEF5350);

  /// Màu thành công
  static const Color successGreen = Color(0xFF43A047);
  static const Color successGreenLight = Color(0xFF66BB6A);

  /// Màu cảnh báo
  static const Color warningOrange = Color(0xFFFB8C00);

  // ── Neutrals ──────────────────────────────────────────────────────────────
  static const Color grey50  = Color(0xFFFAFAFA);
  static const Color grey100 = Color(0xFFF5F5F5);
  static const Color grey200 = Color(0xFFEEEEEE);
  static const Color grey300 = Color(0xFFE0E0E0);
  static const Color grey400 = Color(0xFFBDBDBD);
  static const Color grey500 = Color(0xFF9E9E9E);
  static const Color grey600 = Color(0xFF757575);
  static const Color grey700 = Color(0xFF616161);
  static const Color grey800 = Color(0xFF424242);
  static const Color grey900 = Color(0xFF212121);

  // ── Device status colors ──────────────────────────────────────────────────
  /// Thiết bị đang online
  static const Color deviceOnline  = Color(0xFF43A047);

  /// Thiết bị đang offline
  static const Color deviceOffline = Color(0xFFBDBDBD);

  /// Thiết bị đang xử lý lệnh
  static const Color devicePending = Color(0xFFFB8C00);

  /// Thiết bị lỗi
  static const Color deviceError   = Color(0xFFE53935);

  // ── Category accent colors (dùng cho device card) ─────────────────────────
  static const Color catLight     = Color(0xFFFFF176); // Đèn
  static const Color catClimate   = Color(0xFF81D4FA); // Điều hòa
  static const Color catSecurity  = Color(0xFFCE93D8); // Bảo mật
  static const Color catOutlet    = Color(0xFFA5D6A7); // Ổ cắm
  static const Color catSensor    = Color(0xFF80DEEA); // Cảm biến
  static const Color catGeneric   = Color(0xFFBCAAA4); // Khác

  // ── Glow colors (Hallmark Premium — cho active/ON state) ──────────────────
  // Dùng làm BoxShadow color với blur lớn để tạo hiệu ứng ánh sáng lan tỏa.
  /// Glow chung cho primary accent
  static const Color glowPrimary      = Color(0x4000B4A6); // teal 25%
  static const Color glowPrimaryLight = Color(0x2600B4A6); // teal 15%

  /// Glow theo category thiết bị (opacity thấp, blur lớn → mềm mại)
  static const Color glowLight     = Color(0x33FFD54F); // vàng ấm 20%
  static const Color glowClimate   = Color(0x3342A5F5); // xanh dương 20%
  static const Color glowSecurity  = Color(0x33AB47BC); // tím 20%
  static const Color glowSensor    = Color(0x3326C6DA); // cyan 20%
  static const Color glowFan       = Color(0x3366BB6A); // xanh lá 20%
  static const Color glowGeneric   = Color(0x339E9E9E); // xám 20%

  // ── Sensor value color coding ─────────────────────────────────────────────
  /// Giá trị bình thường
  static const Color sensorNormal  = Color(0xFF43A047);
  /// Giá trị cảnh báo (gần giới hạn)
  static const Color sensorWarning = Color(0xFFFB8C00);
  /// Giá trị nguy hiểm (vượt giới hạn)
  static const Color sensorDanger  = Color(0xFFE53935);

  /// Trả về glow color theo product category.
  static Color glowForCategory(String category) {
    switch (category) {
      case 'light':
      case 'led':
        return glowLight;
      case 'ac':
      case 'hvac':
      case 'environment':
        return glowClimate;
      case 'security':
        return glowSecurity;
      case 'sensor':
        return glowSensor;
      case 'fan':
        return glowFan;
      default:
        return glowGeneric;
    }
  }

  /// Trả về solid accent color theo product category.
  static Color colorForCategory(String category) {
    switch (category) {
      case 'light':
      case 'led':
        return catLight;
      case 'ac':
      case 'hvac':
      case 'environment':
        return catClimate;
      case 'security':
        return catSecurity;
      case 'sensor':
        return catSensor;
      case 'fan':
        return catOutlet;
      default:
        return catGeneric;
    }
  }
}
