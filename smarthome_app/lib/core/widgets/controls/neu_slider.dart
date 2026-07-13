import 'package:flutter/material.dart';
import '../../core.dart';
import '../primitives/neu_container.dart';

/// Thanh trượt liên tục (slider) phong cách Neumorphic.
/// Track luôn lún (pressed), thumb lồi (raised).
class NeuSlider extends StatefulWidget {
  const NeuSlider({
    super.key,
    required this.value,
    required this.onChanged,
    this.min = 0.0,
    this.max = 100.0,
    this.trackHeight = 12.0,
    this.thumbSize = 24.0,
    this.activeColor,
  });

  final double value;
  final ValueChanged<double> onChanged;
  final double min;
  final double max;
  final double trackHeight;
  final double thumbSize;
  final Color? activeColor;

  @override
  State<NeuSlider> createState() => _NeuSliderState();
}

class _NeuSliderState extends State<NeuSlider> {
  void _updateValue(Offset localPosition, double width) {
    if (width <= 0) return;
    
    // Tính phần trăm dựa trên vị trí chạm so với chiều dài slider
    // Trừ đi nửa thumbSize ở 2 đầu để thumb không bị tràn
    final padding = widget.thumbSize / 2;
    final usableWidth = width - widget.thumbSize;
    
    double percent = (localPosition.dx - padding) / usableWidth;
    percent = percent.clamp(0.0, 1.0);
    
    final newValue = widget.min + (widget.max - widget.min) * percent;
    widget.onChanged(newValue);
  }

  @override
  Widget build(BuildContext context) {
    final percent = ((widget.value - widget.min) / (widget.max - widget.min)).clamp(0.0, 1.0);
    final color = widget.activeColor ?? context.colorScheme.primary;

    return LayoutBuilder(
      builder: (context, constraints) {
        final width = constraints.maxWidth;
        // Tính vị trí left của thumb
        final usableWidth = width - widget.thumbSize;
        final thumbLeft = usableWidth * percent;

        return GestureDetector(
          onPanUpdate: (details) => _updateValue(details.localPosition, width),
          onTapDown: (details) => _updateValue(details.localPosition, width),
          behavior: HitTestBehavior.opaque,
          child: SizedBox(
            height: widget.thumbSize,
            width: width,
            child: Stack(
              alignment: Alignment.centerLeft,
              children: [
                // Track nền (pressed - lún)
                NeuContainer(
                  width: width,
                  height: widget.trackHeight,
                  borderRadius: AppRadius.full,
                  depth: NeuDepth.pressed,
                ),
                
                // Track active (phần đã lấp đầy)
                Container(
                  width: thumbLeft + (widget.thumbSize / 2),
                  height: widget.trackHeight,
                  decoration: BoxDecoration(
                    color: color,
                    borderRadius: BorderRadius.circular(AppRadius.full),
                  ),
                ),
                
                // Thumb (raised - nổi)
                Positioned(
                  left: thumbLeft,
                  child: NeuContainer(
                    width: widget.thumbSize,
                    height: widget.thumbSize,
                    shape: BoxShape.circle,
                    depth: NeuDepth.raisedMedium,
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
              ],
            ),
          ),
        );
      },
    );
  }
}
