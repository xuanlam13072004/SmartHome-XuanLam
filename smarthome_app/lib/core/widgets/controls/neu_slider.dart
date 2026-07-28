import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../../core.dart';
import '../primitives/neu_container.dart';

/// Thanh trượt liên tục (slider) phong cách Neumorphic — Hallmark Premium.
/// Track lún (pressed), active track gradient, thumb lồi với glow khi kéo.
class NeuSlider extends StatefulWidget {
  const NeuSlider({
    super.key,
    required this.value,
    required this.onChanged,
    this.min = 0.0,
    this.max = 100.0,
    this.trackHeight = 12.0,
    this.thumbSize = 26.0,
    this.activeColor,
    this.showLabel = false,
    this.unit = '',
  });

  final double value;
  final ValueChanged<double> onChanged;
  final double min;
  final double max;
  final double trackHeight;
  final double thumbSize;
  final Color? activeColor;

  /// Hallmark: Hiện floating label khi kéo.
  final bool showLabel;
  final String unit;

  @override
  State<NeuSlider> createState() => _NeuSliderState();
}

class _NeuSliderState extends State<NeuSlider> {
  bool _isDragging = false;

  void _updateValue(Offset localPosition, double width) {
    if (width <= 0) return;
    
    final padding = widget.thumbSize / 2;
    final usableWidth = width - widget.thumbSize;
    
    double percent = (localPosition.dx - padding) / usableWidth;
    percent = percent.clamp(0.0, 1.0);
    
    final newValue = widget.min + (widget.max - widget.min) * percent;
    widget.onChanged(newValue);
  }

  @override
  Widget build(BuildContext context) {
    final percent = ((widget.value - widget.min) / (widget.max - widget.min))
        .clamp(0.0, 1.0);
    final color = widget.activeColor ?? context.colorScheme.primary;
    // Hallmark: Gradient track — từ primary → primary light
    final gradientEnd = HSLColor.fromColor(color)
        .withLightness((HSLColor.fromColor(color).lightness + 0.15).clamp(0.0, 1.0))
        .toColor();

    return LayoutBuilder(
      builder: (context, constraints) {
        final width = constraints.maxWidth;
        final usableWidth = width - widget.thumbSize;
        final thumbLeft = usableWidth * percent;

        return GestureDetector(
          onPanStart: (_) {
            setState(() => _isDragging = true);
            HapticFeedback.selectionClick();
          },
          onPanUpdate: (details) => _updateValue(details.localPosition, width),
          onPanEnd: (_) => setState(() => _isDragging = false),
          onTapDown: (details) {
            _updateValue(details.localPosition, width);
            HapticFeedback.selectionClick();
          },
          behavior: HitTestBehavior.opaque,
          child: SizedBox(
            height: widget.thumbSize + (widget.showLabel ? 28 : 0),
            width: width,
            child: Stack(
              clipBehavior: Clip.none,
              alignment: Alignment.centerLeft,
              children: [
                // Track nền (pressed - lún)
                Positioned(
                  top: widget.showLabel ? 28 : 0,
                  left: 0,
                  right: 0,
                  child: SizedBox(
                    height: widget.thumbSize,
                    child: Center(
                      child: NeuContainer(
                        width: width,
                        height: widget.trackHeight,
                        borderRadius: AppRadius.full,
                        depth: NeuDepth.pressed,
                      ),
                    ),
                  ),
                ),
                
                // Active track gradient
                Positioned(
                  top: widget.showLabel
                      ? 28 + (widget.thumbSize - widget.trackHeight) / 2
                      : (widget.thumbSize - widget.trackHeight) / 2,
                  left: 0,
                  child: AnimatedContainer(
                    duration: const Duration(milliseconds: 60),
                    width: thumbLeft + (widget.thumbSize / 2),
                    height: widget.trackHeight,
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        colors: [color, gradientEnd],
                        begin: Alignment.centerLeft,
                        end: Alignment.centerRight,
                      ),
                      borderRadius: BorderRadius.circular(AppRadius.full),
                    ),
                  ),
                ),
                
                // Thumb (raised - nổi, glow khi kéo)
                Positioned(
                  top: widget.showLabel ? 28 : 0,
                  left: thumbLeft,
                  child: AnimatedScale(
                    scale: _isDragging ? 1.15 : 1.0,
                    duration: const Duration(milliseconds: 150),
                    curve: Curves.easeOutCubic,
                    child: NeuContainer(
                      width: widget.thumbSize,
                      height: widget.thumbSize,
                      shape: BoxShape.circle,
                      depth: NeuDepth.raisedMedium,
                      glowColor: _isDragging
                          ? color.withValues(alpha: 0.35)
                          : null,
                      child: Center(
                        child: Container(
                          width: widget.thumbSize * 0.4,
                          height: widget.thumbSize * 0.4,
                          decoration: BoxDecoration(
                            shape: BoxShape.circle,
                            color: color,
                          ),
                        ),
                      ),
                    ),
                  ),
                ),

                // Floating label (Hallmark)
                if (widget.showLabel)
                  Positioned(
                    top: 0,
                    left: thumbLeft + widget.thumbSize / 2 - 20,
                    child: AnimatedOpacity(
                      duration: const Duration(milliseconds: 150),
                      opacity: _isDragging ? 1.0 : 0.0,
                      child: Container(
                        width: 40,
                        height: 24,
                        alignment: Alignment.center,
                        decoration: BoxDecoration(
                          color: color,
                          borderRadius: BorderRadius.circular(AppRadius.sm),
                        ),
                        child: Text(
                          '${widget.value.round()}${widget.unit}',
                          style: context.textTheme.labelSmall?.copyWith(
                            color: context.colorScheme.onPrimary,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        );
      },
    );
  }
}
