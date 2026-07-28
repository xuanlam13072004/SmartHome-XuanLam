import 'dart:math' as math;
import 'package:flutter/material.dart';
import '../../../../core/core.dart';
import '../../../../core/widgets/widgets.dart';
import '../../models/capability_model.dart';
import 'capability_visuals.dart';

/// Hallmark Premium: Sensor widget với circular gauge, color coding, icon.
class CapabilitySensorWidget extends StatelessWidget {
  const CapabilitySensorWidget({
    super.key,
    required this.capability,
  });

  final CapabilityModel capability;

  @override
  Widget build(BuildContext context) {
    final value = capability.value;
    final min = (capability.properties['min'] as num?)?.toDouble();
    final max = (capability.properties['max'] as num?)?.toDouble();
    final numericValue = (value as num?)?.toDouble();
    final hasGauge =
        numericValue != null && min != null && max != null && max > min;
    final progress =
        hasGauge ? ((numericValue - min) / (max - min)).clamp(0.0, 1.0) : 0.0;
    final accent = CapabilityVisuals.accentFor(context, capability);

    // Hallmark: Color coding dựa trên % trong range
    final gaugeColor = hasGauge
        ? _colorForProgress(progress, accent)
        : accent;

    return Semantics(
      container: true,
      readOnly: true,
      label: capability.name,
      value: CapabilityVisuals.valueText(capability),
      child: NeuCard(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Row(
          children: [
            Expanded(
              child: CapabilityHeading(capability: capability),
            ),
            const SizedBox(width: AppSpacing.sm),
            if (hasGauge)
              SizedBox.square(
                dimension: 72,
                child: _AnimatedGauge(
                  progress: progress,
                  color: gaugeColor,
                  valueText: CapabilityVisuals.valueText(capability),
                  textStyle: context.textTheme.titleSmall?.copyWith(
                    color: context.colorScheme.onSurface,
                    fontWeight: FontWeight.w700,
                  ),
                  backgroundColor:
                      context.colorScheme.surfaceContainerHighest,
                ),
              )
            else
              Flexible(
                child: Text(
                  CapabilityVisuals.valueText(capability),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.end,
                  style: context.textTheme.headlineSmall?.copyWith(
                    color: gaugeColor,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  /// Hallmark: Color code dựa trên progress (0→1).
  /// 0–70% = accent (bình thường), 70–85% = warning, 85–100% = danger.
  Color _colorForProgress(double progress, Color accent) {
    if (progress > 0.85) return AppPalette.sensorDanger;
    if (progress > 0.70) return AppPalette.sensorWarning;
    return accent;
  }
}

/// Hallmark: Circular gauge với animation mượt cho sensor values.
class _AnimatedGauge extends StatelessWidget {
  const _AnimatedGauge({
    required this.progress,
    required this.color,
    required this.valueText,
    required this.backgroundColor,
    this.textStyle,
  });

  final double progress;
  final Color color;
  final String valueText;
  final Color backgroundColor;
  final TextStyle? textStyle;

  @override
  Widget build(BuildContext context) {
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0.0, end: progress),
      duration: const Duration(milliseconds: 600),
      curve: Curves.easeOutCubic,
      builder: (context, animatedProgress, child) {
        return CustomPaint(
          painter: _GaugePainter(
            progress: animatedProgress,
            color: color,
            backgroundColor: backgroundColor,
            strokeWidth: 6.0,
          ),
          child: child,
        );
      },
      child: Center(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.sm),
          child: FittedBox(
            fit: BoxFit.scaleDown,
            child: Text(
              valueText,
              style: textStyle,
            ),
          ),
        ),
      ),
    );
  }
}

/// Custom painter cho circular gauge kiểu Apple Home.
class _GaugePainter extends CustomPainter {
  const _GaugePainter({
    required this.progress,
    required this.color,
    required this.backgroundColor,
    required this.strokeWidth,
  });

  final double progress;
  final Color color;
  final Color backgroundColor;
  final double strokeWidth;

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final radius = (math.min(size.width, size.height) - strokeWidth) / 2;
    const startAngle = -math.pi / 2; // Bắt đầu từ 12 giờ
    const sweepTotal = 2 * math.pi;

    // Background arc
    canvas.drawArc(
      Rect.fromCircle(center: center, radius: radius),
      startAngle,
      sweepTotal,
      false,
      Paint()
        ..color = backgroundColor
        ..style = PaintingStyle.stroke
        ..strokeWidth = strokeWidth
        ..strokeCap = StrokeCap.round,
    );

    // Active arc
    if (progress > 0) {
      canvas.drawArc(
        Rect.fromCircle(center: center, radius: radius),
        startAngle,
        sweepTotal * progress,
        false,
        Paint()
          ..color = color
          ..style = PaintingStyle.stroke
          ..strokeWidth = strokeWidth
          ..strokeCap = StrokeCap.round,
      );
    }
  }

  @override
  bool shouldRepaint(_GaugePainter oldDelegate) =>
      progress != oldDelegate.progress ||
      color != oldDelegate.color ||
      backgroundColor != oldDelegate.backgroundColor;
}
