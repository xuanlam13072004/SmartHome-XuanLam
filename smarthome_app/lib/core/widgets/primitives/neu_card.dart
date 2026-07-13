import 'package:flutter/material.dart';
import '../../core.dart';
import 'neu_container.dart';

/// Wrapper của NeuContainer dành riêng cho các Card hiển thị nội dung.
/// Tự động có padding chuẩn (AppSpacing.md) và border radius lớn (AppRadius.lg).
class NeuCard extends StatelessWidget {
  const NeuCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(AppSpacing.md),
    this.margin,
    this.depth = NeuDepth.raisedMedium,
    this.color,
  });

  final Widget child;
  final EdgeInsetsGeometry? padding;
  final EdgeInsetsGeometry? margin;
  final NeuDepth depth;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    return NeuContainer(
      padding: padding,
      margin: margin,
      borderRadius: AppRadius.lg, // Card chuẩn dùng borderRadius lg (24)
      depth: depth,
      color: color,
      child: child,
    );
  }
}
