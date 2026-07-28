// lib/core/tokens/app_shadows.dart
//
// Neumorphic shadow system — ánh sáng từ góc trên-trái.
// Hallmark Redesign: Giảm intensity 30% → mềm mại, premium hơn.
// Thêm glow variant cho active/ON state.
//
// Nguyên tắc:
//   - Raised: element nhô lên khỏi bề mặt (default card state)
//   - Flat: element phẳng, ít chiều sâu (inactive, subtle)
//   - Pressed: element bị nhấn xuống (inset, active toggle)
//   - Glow: element phát sáng lan tỏa (active device)

import 'package:flutter/material.dart';

/// Model biểu diễn một cặp shadow Neumorphic (dark + light).
class NeuShadowStyle {
  const NeuShadowStyle({
    required this.shadows,
  });

  final List<BoxShadow> shadows;
}

/// Factory tạo shadow theo theme brightness.
abstract final class AppShadows {
  // ── Raised (element nhô lên) ───────────────────────────────────────────────

  /// Raised — cường độ mạnh (hero card, FAB)
  /// Hallmark: offset 6→6 (was 8), blur 14→14 (was 16)
  static NeuShadowStyle raisedStrong({
    required Color darkShadow,
    required Color lightShadow,
  }) =>
      NeuShadowStyle(shadows: [
        BoxShadow(
          color: darkShadow,
          offset: const Offset(6, 6),
          blurRadius: 14,
        ),
        BoxShadow(
          color: lightShadow,
          offset: const Offset(-6, -6),
          blurRadius: 14,
        ),
      ]);

  /// Raised — cường độ thường (card, button)
  /// Hallmark: offset 4→4 (was 5), blur 8→8 (was 10)
  static NeuShadowStyle raisedMedium({
    required Color darkShadow,
    required Color lightShadow,
  }) =>
      NeuShadowStyle(shadows: [
        BoxShadow(
          color: darkShadow,
          offset: const Offset(4, 4),
          blurRadius: 8,
        ),
        BoxShadow(
          color: lightShadow,
          offset: const Offset(-4, -4),
          blurRadius: 8,
        ),
      ]);

  /// Raised — cường độ nhẹ (icon container, chip)
  /// Hallmark: offset 2→2 (was 3), blur 5→5 (was 6)
  static NeuShadowStyle raisedSubtle({
    required Color darkShadow,
    required Color lightShadow,
  }) =>
      NeuShadowStyle(shadows: [
        BoxShadow(
          color: darkShadow,
          offset: const Offset(2, 2),
          blurRadius: 5,
        ),
        BoxShadow(
          color: lightShadow,
          offset: const Offset(-2, -2),
          blurRadius: 5,
        ),
      ]);

  // ── Flat (phẳng, ít chiều sâu) ────────────────────────────────────────────

  /// Flat — element gần như flush với bề mặt
  static NeuShadowStyle flat({
    required Color darkShadow,
    required Color lightShadow,
  }) =>
      NeuShadowStyle(shadows: [
        BoxShadow(
          color: darkShadow,
          offset: const Offset(1, 1),
          blurRadius: 3,
        ),
        BoxShadow(
          color: lightShadow,
          offset: const Offset(-1, -1),
          blurRadius: 3,
        ),
      ]);

  // ── Pressed (nhấn xuống) ──────────────────────────────────────────────────

  /// Pressed — element bị ấn, đổi chiều shadow (inset effect)
  /// Hallmark: offset -3→3 (was -4→4), blur 6 (was 8)
  static NeuShadowStyle pressed({
    required Color darkShadow,
    required Color lightShadow,
  }) =>
      NeuShadowStyle(shadows: [
        BoxShadow(
          color: darkShadow,
          offset: const Offset(-3, -3),
          blurRadius: 6,
        ),
        BoxShadow(
          color: lightShadow,
          offset: const Offset(3, 3),
          blurRadius: 6,
        ),
      ]);

  // ── Glow (phát sáng — Hallmark Premium) ───────────────────────────────────

  /// Glow — hiệu ứng ánh sáng lan tỏa cho thiết bị đang active/ON.
  /// Kết hợp raised shadow bình thường + một lớp glow color bao quanh.
  static NeuShadowStyle glow({
    required Color darkShadow,
    required Color lightShadow,
    required Color glowColor,
    double glowRadius = 16.0,
    double glowSpread = 1.0,
  }) =>
      NeuShadowStyle(shadows: [
        // Neumorphic pair bình thường
        BoxShadow(
          color: darkShadow,
          offset: const Offset(3, 3),
          blurRadius: 6,
        ),
        BoxShadow(
          color: lightShadow,
          offset: const Offset(-3, -3),
          blurRadius: 6,
        ),
        // Glow layer — lan tỏa, không offset
        BoxShadow(
          color: glowColor,
          offset: Offset.zero,
          blurRadius: glowRadius,
          spreadRadius: glowSpread,
        ),
      ]);

  // ── No shadow ─────────────────────────────────────────────────────────────
  static const NeuShadowStyle none = NeuShadowStyle(shadows: []);
}
