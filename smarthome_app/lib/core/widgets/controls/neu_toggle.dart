import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../../core.dart';
import '../primitives/neu_container.dart';

/// Switch bật/tắt Neumorphic.
/// Khi Off: lồi lên (raised). Khi On: lún xuống (pressed).
class NeuToggle extends StatelessWidget {
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

  void _handleTap() {
    if (isDisabled) return;
    HapticFeedback.selectionClick();
    onChanged(!value);
  }

  @override
  Widget build(BuildContext context) {
    final thumbSize = height - 8.0; // Padding 4px mỗi bên
    final activeColor = context.colorScheme.primary;
    final inactiveColor = context.colorScheme.onSurfaceVariant.withValues(alpha: 0.5);

    return GestureDetector(
      onTap: _handleTap,
      behavior: HitTestBehavior.opaque,
      child: AnimatedOpacity(
        duration: const Duration(milliseconds: 150),
        opacity: isDisabled ? 0.5 : 1.0,
        child: NeuContainer(
          width: width,
          height: height,
          borderRadius: AppRadius.full,
          // Background lún khi bật, lồi khi tắt
          depth: value ? NeuDepth.pressed : NeuDepth.raisedSubtle,
          child: Stack(
            alignment: Alignment.centerLeft,
            children: [
              // Thumb
              AnimatedPositioned(
                duration: const Duration(milliseconds: 200),
                curve: Curves.easeOutBack,
                left: value ? width - thumbSize - 4.0 : 4.0,
                child: NeuContainer(
                  width: thumbSize,
                  height: thumbSize,
                  shape: BoxShape.circle,
                  depth: NeuDepth.raisedMedium, // Thumb luôn lồi
                  color: value ? activeColor : context.neu.surface,
                  child: Center(
                    child: Container(
                      width: thumbSize * 0.4,
                      height: thumbSize * 0.4,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: value 
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
    );
  }
}
