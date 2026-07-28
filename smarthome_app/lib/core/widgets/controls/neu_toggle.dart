import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../../core.dart';
import '../primitives/neu_container.dart';

/// Switch bật/tắt Neumorphic — Premium Hallmark edition.
/// ON: thumb phát sáng, track lún. OFF: thumb raised, track phẳng.
/// Micro-interactions: scale feedback on tap, spring thumb animation.
class NeuToggle extends StatefulWidget {
  const NeuToggle({
    super.key,
    required this.value,
    required this.onChanged,
    this.width = 60.0,
    this.height = 32.0,
    this.isDisabled = false,
  });

  final bool value;
  final ValueChanged<bool> onChanged;
  final double width;
  final double height;
  final bool isDisabled;

  @override
  State<NeuToggle> createState() => _NeuToggleState();
}

class _NeuToggleState extends State<NeuToggle>
    with SingleTickerProviderStateMixin {
  late AnimationController _scaleController;
  late Animation<double> _scaleAnimation;

  @override
  void initState() {
    super.initState();
    _scaleController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 100),
      reverseDuration: const Duration(milliseconds: 80),
    );
    _scaleAnimation = Tween<double>(begin: 1.0, end: 0.92).animate(
      CurvedAnimation(parent: _scaleController, curve: Curves.easeOutCubic),
    );
  }

  @override
  void dispose() {
    _scaleController.dispose();
    super.dispose();
  }

  void _handleTapDown(TapDownDetails _) {
    if (widget.isDisabled) return;
    _scaleController.forward();
  }

  void _handleTapUp(TapUpDetails _) {
    _scaleController.reverse();
    if (widget.isDisabled) return;
    HapticFeedback.selectionClick();
    widget.onChanged(!widget.value);
  }

  void _handleTapCancel() {
    _scaleController.reverse();
  }

  @override
  Widget build(BuildContext context) {
    final thumbSize = widget.height - 8.0;
    final activeColor = context.colorScheme.primary;
    final inactiveColor =
        context.colorScheme.onSurfaceVariant.withValues(alpha: 0.4);

    return GestureDetector(
      onTapDown: _handleTapDown,
      onTapUp: _handleTapUp,
      onTapCancel: _handleTapCancel,
      behavior: HitTestBehavior.opaque,
      child: ScaleTransition(
        scale: _scaleAnimation,
        child: AnimatedOpacity(
          duration: const Duration(milliseconds: 150),
          opacity: widget.isDisabled ? 0.45 : 1.0,
          child: NeuContainer(
            width: widget.width,
            height: widget.height,
            borderRadius: AppRadius.full,
            depth: widget.value ? NeuDepth.pressed : NeuDepth.raisedSubtle,
            child: Stack(
              alignment: Alignment.centerLeft,
              children: [
                // Thumb
                AnimatedPositioned(
                  duration: const Duration(milliseconds: 250),
                  curve: Curves.easeOutBack,
                  left: widget.value
                      ? widget.width - thumbSize - 4.0
                      : 4.0,
                  child: NeuContainer(
                    width: thumbSize,
                    height: thumbSize,
                    shape: BoxShape.circle,
                    depth: NeuDepth.raisedMedium,
                    color: widget.value ? activeColor : context.neu.surface,
                    // Hallmark: glow lan tỏa khi ON
                    glowColor: widget.value
                        ? activeColor.withValues(alpha: 0.3)
                        : null,
                    child: Center(
                      child: AnimatedContainer(
                        duration: const Duration(milliseconds: 200),
                        width: thumbSize * 0.35,
                        height: thumbSize * 0.35,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: widget.value
                              ? context.colorScheme.onPrimary
                              : inactiveColor,
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
