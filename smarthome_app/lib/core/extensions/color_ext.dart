// lib/core/extensions/color_ext.dart
//
// Extension methods cho Color — dùng để tạo shade nhạt/đậm hơn
// mà không cần khai báo màu mới trong palette.

import 'package:flutter/material.dart';

extension AppColorExt on Color {
  /// Làm sáng màu lên [amount] (0.0 → 1.0).
  /// Ví dụ: color.lighten(0.1) → sáng hơn 10%
  Color lighten([double amount = 0.1]) {
    assert(amount >= 0 && amount <= 1, 'amount must be between 0 and 1');
    final hsl = HSLColor.fromColor(this);
    return hsl
        .withLightness((hsl.lightness + amount).clamp(0.0, 1.0))
        .toColor();
  }

  /// Làm tối màu xuống [amount] (0.0 → 1.0).
  Color darken([double amount = 0.1]) {
    assert(amount >= 0 && amount <= 1, 'amount must be between 0 and 1');
    final hsl = HSLColor.fromColor(this);
    return hsl
        .withLightness((hsl.lightness - amount).clamp(0.0, 1.0))
        .toColor();
  }

  /// Thêm alpha (opacity) vào màu hiện tại.
  /// Tương đương withOpacity nhưng tên rõ nghĩa hơn.
  Color withAlpha01(double opacity) {
    assert(opacity >= 0.0 && opacity <= 1.0);
    return withValues(alpha: opacity);
  }

  /// Trộn màu hiện tại với [other] theo tỷ lệ [t] (0.0 = giữ nguyên, 1.0 = dùng other).
  Color blend(Color other, double t) => Color.lerp(this, other, t)!;

  /// Trả về màu text phù hợp (đen hoặc trắng) dựa trên độ sáng của màu nền.
  /// Hữu ích cho overlay text trên dynamic background.
  Color get contrastingText {
    final luminance = computeLuminance();
    return luminance > 0.179 ? Colors.black87 : Colors.white;
  }

  /// Trả về màu nền đã được làm nhạt nhẹ để dùng cho container (chip, badge bg).
  Color get containerVariant => withValues(alpha: 0.15);
}
