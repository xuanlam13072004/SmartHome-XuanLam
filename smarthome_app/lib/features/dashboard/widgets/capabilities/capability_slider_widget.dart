import 'package:flutter/material.dart';
import '../../../../core/core.dart';
import '../../../../core/widgets/widgets.dart';
import '../../models/capability_model.dart';
import 'capability_visuals.dart';

class CapabilitySliderWidget extends StatelessWidget {
  const CapabilitySliderWidget({
    super.key,
    required this.capability,
    required this.onChanged,
  });

  final CapabilityModel capability;
  final ValueChanged<double> onChanged;

  @override
  Widget build(BuildContext context) {
    // Phân tích metadata
    final double currentValue = (capability.value as num?)?.toDouble() ?? 0.0;
    final props = capability.properties;
    final min = (props['min'] as num?)?.toDouble() ?? 0.0;
    final max = (props['max'] as num?)?.toDouble() ?? 100.0;
    final step = (props['step'] as num?)?.toDouble();
    final safeMax = max > min ? max : min + 1;
    final safeValue = currentValue.clamp(min, safeMax).toDouble();
    final divisions = step != null && step > 0
        ? ((safeMax - min) / step).round().clamp(1, 1000)
        : null;
    final accent = CapabilityVisuals.accentFor(context, capability);

    return Semantics(
      container: true,
      slider: true,
      enabled: !capability.isReadOnly,
      label: capability.name,
      value: CapabilityVisuals.valueText(capability),
      child: NeuCard(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            CapabilityHeading(
              capability: capability,
              trailing: DecoratedBox(
                decoration: BoxDecoration(
                  color: accent.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(AppRadius.full),
                ),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: AppSpacing.smMd,
                    vertical: AppSpacing.sm,
                  ),
                  child: Text(
                    CapabilityVisuals.valueText(capability),
                    style: context.textTheme.labelLarge?.copyWith(
                      color: context.colorScheme.primary,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
              ),
            ),
            const SizedBox(height: AppSpacing.lg),
            SliderTheme(
              data: SliderTheme.of(context).copyWith(
                trackHeight: 8,
                activeTrackColor: accent,
                inactiveTrackColor: context.colorScheme.surfaceContainerHighest,
                thumbColor: accent,
                overlayColor: accent.withValues(alpha: 0.12),
                disabledActiveTrackColor: accent.withValues(alpha: 0.35),
                disabledInactiveTrackColor:
                    context.colorScheme.surfaceContainerHighest,
                disabledThumbColor:
                    context.colorScheme.onSurfaceVariant.withValues(alpha: 0.5),
                trackShape: _GradientSliderTrackShape(
                  startColor: accent,
                  endColor: context.colorScheme.primary,
                ),
              ),
              child: Slider(
                value: safeValue,
                min: min,
                max: safeMax,
                divisions: divisions,
                onChanged: capability.isReadOnly ? null : onChanged,
              ),
            ),
            const SizedBox(height: AppSpacing.xs),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(_axisLabel(min), style: context.textTheme.labelSmall),
                Text(_axisLabel(safeMax), style: context.textTheme.labelSmall),
              ],
            ),
          ],
        ),
      ),
    );
  }

  String _axisLabel(double value) {
    final unit = capability.properties['unit']?.toString() ?? '';
    final number = value == value.roundToDouble()
        ? value.toInt().toString()
        : value.toStringAsFixed(1);
    return unit.isEmpty ? number : '$number$unit';
  }
}

class _GradientSliderTrackShape extends RoundedRectSliderTrackShape {
  const _GradientSliderTrackShape({
    required this.startColor,
    required this.endColor,
  });

  final Color startColor;
  final Color endColor;

  @override
  void paint(
    PaintingContext context,
    Offset offset, {
    required RenderBox parentBox,
    required SliderThemeData sliderTheme,
    required Animation<double> enableAnimation,
    required TextDirection textDirection,
    required Offset thumbCenter,
    Offset? secondaryOffset,
    bool isDiscrete = false,
    bool isEnabled = false,
    double additionalActiveTrackHeight = 2,
  }) {
    final trackRect = getPreferredRect(
      parentBox: parentBox,
      offset: offset,
      sliderTheme: sliderTheme,
      isEnabled: isEnabled,
      isDiscrete: isDiscrete,
    );
    final radius = Radius.circular(trackRect.height / 2);
    final canvas = context.canvas;
    canvas.drawRRect(
      RRect.fromRectAndRadius(trackRect, radius),
      Paint()
        ..color = sliderTheme.inactiveTrackColor ??
            sliderTheme.disabledInactiveTrackColor ??
            Colors.transparent,
    );

    final activeRect = Rect.fromLTRB(
      textDirection == TextDirection.ltr ? trackRect.left : thumbCenter.dx,
      trackRect.top,
      textDirection == TextDirection.ltr ? thumbCenter.dx : trackRect.right,
      trackRect.bottom,
    );
    if (activeRect.width <= 0) return;
    final colors = isEnabled
        ? [startColor, endColor]
        : [
            startColor.withValues(alpha: 0.35),
            endColor.withValues(alpha: 0.35),
          ];
    canvas.drawRRect(
      RRect.fromRectAndRadius(activeRect, radius),
      Paint()..shader = LinearGradient(colors: colors).createShader(activeRect),
    );
  }
}
