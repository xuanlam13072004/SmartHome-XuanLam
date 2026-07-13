import 'package:flutter/material.dart';
import '../../core.dart';
import 'neu_container.dart';

/// Hộp chứa Icon với tỷ lệ 1:1, thường dùng ở góc card hoặc list item.
class NeuIconBox extends StatelessWidget {
  const NeuIconBox({
    super.key,
    required this.icon,
    this.size = 48.0,
    this.iconSize = 24.0,
    this.iconColor,
    this.backgroundColor,
    this.shape = BoxShape.rectangle,
    this.borderRadius = AppRadius.md,
    this.depth = NeuDepth.raisedSubtle,
    this.isActive = false,
    this.activeIconColor,
  });

  final IconData icon;
  final double size;
  final double iconSize;
  
  /// Màu icon mặc định. Nếu null lấy từ theme
  final Color? iconColor;
  
  /// Màu icon khi isActive = true
  final Color? activeIconColor;
  
  final Color? backgroundColor;
  final BoxShape shape;
  final double borderRadius;
  final NeuDepth depth;
  
  /// Nếu active, dùng activeIconColor và đổi depth sang pressed
  final bool isActive;

  @override
  Widget build(BuildContext context) {
    final defaultIconColor = context.colorScheme.onSurfaceVariant;
    final defaultActiveColor = context.colorScheme.primary;

    final targetIconColor = isActive 
        ? (activeIconColor ?? defaultActiveColor)
        : (iconColor ?? defaultIconColor);

    final targetDepth = isActive ? NeuDepth.pressed : depth;

    return NeuContainer(
      width: size,
      height: size,
      shape: shape,
      borderRadius: shape == BoxShape.circle ? null : borderRadius,
      depth: targetDepth,
      color: backgroundColor,
      child: Center(
        child: AnimatedSwitcher(
          duration: const Duration(milliseconds: 150),
          child: Icon(
            icon,
            key: ValueKey<bool>(isActive),
            size: iconSize,
            color: targetIconColor,
          ),
        ),
      ),
    );
  }
}
