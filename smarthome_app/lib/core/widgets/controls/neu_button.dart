import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../../core.dart';
import '../primitives/neu_container.dart';

/// Nút bấm Neumorphic hỗ trợ tactile feedback (lún xuống khi nhấn).
class NeuButton extends StatefulWidget {
  const NeuButton({
    super.key,
    required this.onPressed,
    required this.child,
    this.padding = const EdgeInsets.symmetric(
      horizontal: AppSpacing.lg,
      vertical: AppSpacing.md,
    ),
    this.depth = NeuDepth.raisedMedium,
    this.borderRadius = AppRadius.md,
    this.color,
    this.isDisabled = false,
  });

  /// Constructor tiện ích cho nút chỉ có Text
  factory NeuButton.text(
    String text, {
    Key? key,
    required VoidCallback onPressed,
    NeuDepth depth = NeuDepth.raisedMedium,
    bool isDisabled = false,
  }) {
    return NeuButton(
      key: key,
      onPressed: onPressed,
      depth: depth,
      isDisabled: isDisabled,
      child: Text(text),
    );
  }

  /// Constructor tiện ích cho nút chỉ có Icon
  factory NeuButton.icon(
    IconData icon, {
    Key? key,
    required VoidCallback onPressed,
    NeuDepth depth = NeuDepth.raisedMedium,
    bool isDisabled = false,
  }) {
    return NeuButton(
      key: key,
      onPressed: onPressed,
      depth: depth,
      isDisabled: isDisabled,
      padding: const EdgeInsets.all(AppSpacing.md),
      child: Icon(icon),
    );
  }

  final VoidCallback onPressed;
  final Widget child;
  final EdgeInsetsGeometry padding;
  final NeuDepth depth;
  final double borderRadius;
  final Color? color;
  final bool isDisabled;

  @override
  State<NeuButton> createState() => _NeuButtonState();
}

class _NeuButtonState extends State<NeuButton> {
  bool _isPressed = false;

  void _handleTapDown(TapDownDetails details) {
    if (widget.isDisabled) return;
    HapticFeedback.lightImpact();
    setState(() => _isPressed = true);
  }

  void _handleTapUp(TapUpDetails details) {
    if (widget.isDisabled) return;
    setState(() => _isPressed = false);
    widget.onPressed();
  }

  void _handleTapCancel() {
    if (widget.isDisabled) return;
    setState(() => _isPressed = false);
  }

  @override
  Widget build(BuildContext context) {
    // Nếu disabled -> flat, nếu đang nhấn -> pressed, ngược lại -> theo depth prop.
    final currentDepth = widget.isDisabled 
        ? NeuDepth.flat 
        : (_isPressed ? NeuDepth.pressed : widget.depth);

    return GestureDetector(
      onTapDown: _handleTapDown,
      onTapUp: _handleTapUp,
      onTapCancel: _handleTapCancel,
      behavior: HitTestBehavior.opaque,
      child: NeuContainer(
        padding: widget.padding,
        borderRadius: widget.borderRadius,
        depth: currentDepth,
        color: widget.color,
        child: AnimatedOpacity(
          duration: const Duration(milliseconds: 150),
          opacity: widget.isDisabled ? 0.5 : 1.0,
          child: DefaultTextStyle.merge(
            style: context.textTheme.labelLarge?.copyWith(
              color: context.colorScheme.onSurface,
            ),
            child: IconTheme.merge(
              data: IconThemeData(
                color: context.colorScheme.onSurface,
              ),
              child: widget.child,
            ),
          ),
        ),
      ),
    );
  }
}
