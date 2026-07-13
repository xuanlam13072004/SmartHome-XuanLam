import 'package:flutter/material.dart';
import '../../core.dart';

/// Các trạng thái shadow hỗ trợ của NeuContainer
enum NeuDepth {
  raisedStrong,
  raisedMedium,
  raisedSubtle,
  flat,
  pressed,
  none,
}

/// Nền tảng cơ bản của Neumorphism.
/// Tự động xử lý màu nền, bo góc, và hiệu ứng shadow (animated).
class NeuContainer extends StatelessWidget {
  const NeuContainer({
    super.key,
    this.child,
    this.width,
    this.height,
    this.padding,
    this.margin,
    this.borderRadius,
    this.shape = BoxShape.rectangle,
    this.depth = NeuDepth.raisedMedium,
    this.color,
    this.duration = const Duration(milliseconds: 150),
    this.curve = Curves.easeInOut,
  });

  final Widget? child;
  final double? width;
  final double? height;
  final EdgeInsetsGeometry? padding;
  final EdgeInsetsGeometry? margin;
  
  /// Nếu shape == BoxShape.circle thì bỏ qua borderRadius
  final double? borderRadius;
  final BoxShape shape;
  
  final NeuDepth depth;
  
  /// Nếu null sẽ tự lấy [NeuColors.surface]
  final Color? color;
  
  final Duration duration;
  final Curve curve;

  List<BoxShadow>? _getShadows(NeuColors neu) {
    switch (depth) {
      case NeuDepth.raisedStrong:
        return neu.raisedStrong.shadows;
      case NeuDepth.raisedMedium:
        return neu.raisedMedium.shadows;
      case NeuDepth.raisedSubtle:
        return neu.raisedSubtle.shadows;
      case NeuDepth.flat:
        return neu.flat.shadows;
      case NeuDepth.pressed:
        return neu.pressed.shadows;
      case NeuDepth.none:
        return null;
    }
  }

  @override
  Widget build(BuildContext context) {
    final neu = context.neu;
    final bgColor = color ?? neu.surface;

    return AnimatedContainer(
      duration: duration,
      curve: curve,
      width: width,
      height: height,
      padding: padding,
      margin: margin,
      decoration: BoxDecoration(
        color: bgColor,
        shape: shape,
        borderRadius: shape == BoxShape.rectangle 
            ? BorderRadius.circular(borderRadius ?? AppRadius.md) 
            : null,
        boxShadow: _getShadows(neu),
      ),
      child: child,
    );
  }
}
