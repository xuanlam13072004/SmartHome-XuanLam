// lib/core/tokens/app_shadows.dart
//
// Neumorphic shadow system — ánh sáng từ góc trên-trái.
// Shadow pair = [dark shadow (bottom-right)] + [light shadow (top-left)]
//
// Nguyên tắc:
//   - Raised: element nhô lên khỏi bề mặt (default card state)
//   - Flat: element phẳng, ít chiều sâu (inactive, subtle)
//   - Pressed: element bị nhấn xuống (inset, active toggle)
//   - Inner: bóng bên trong (inset shadow via clip + gradient)

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
  static NeuShadowStyle raisedStrong({
    required Color darkShadow,
    required Color lightShadow,
  }) =>
      NeuShadowStyle(shadows: [
        BoxShadow(
          color: darkShadow,
          offset: const Offset(8, 8),
          blurRadius: 16,
        ),
        BoxShadow(
          color: lightShadow,
          offset: const Offset(-8, -8),
          blurRadius: 16,
        ),
      ]);

  /// Raised — cường độ thường (card, button)
  static NeuShadowStyle raisedMedium({
    required Color darkShadow,
    required Color lightShadow,
  }) =>
      NeuShadowStyle(shadows: [
        BoxShadow(
          color: darkShadow,
          offset: const Offset(5, 5),
          blurRadius: 10,
        ),
        BoxShadow(
          color: lightShadow,
          offset: const Offset(-5, -5),
          blurRadius: 10,
        ),
      ]);

  /// Raised — cường độ nhẹ (icon container, chip)
  static NeuShadowStyle raisedSubtle({
    required Color darkShadow,
    required Color lightShadow,
  }) =>
      NeuShadowStyle(shadows: [
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
          offset: const Offset(2, 2),
          blurRadius: 4,
        ),
        BoxShadow(
          color: lightShadow,
          offset: const Offset(-2, -2),
          blurRadius: 4,
        ),
      ]);

  // ── Pressed (nhấn xuống) ──────────────────────────────────────────────────

  /// Pressed — element bị ấn, đổi chiều shadow (inset effect)
  static NeuShadowStyle pressed({
    required Color darkShadow,
    required Color lightShadow,
  }) =>
      NeuShadowStyle(shadows: [
        // Shadow ngược: tối ở góc trên-trái, sáng ở góc dưới-phải
        BoxShadow(
          color: darkShadow,
          offset: const Offset(-4, -4),
          blurRadius: 8,
        ),
        BoxShadow(
          color: lightShadow,
          offset: const Offset(4, 4),
          blurRadius: 8,
        ),
      ]);

  // ── No shadow ─────────────────────────────────────────────────────────────
  static const NeuShadowStyle none = NeuShadowStyle(shadows: []);
}
