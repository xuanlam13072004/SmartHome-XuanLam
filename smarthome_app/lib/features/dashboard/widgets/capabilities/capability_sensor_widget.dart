import 'package:flutter/material.dart';
import '../../../../core/core.dart';
import '../../../../core/widgets/widgets.dart';
import '../../models/capability_model.dart';
import 'capability_visuals.dart';

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
                dimension: 68,
                child: Stack(
                  fit: StackFit.expand,
                  children: [
                    CircularProgressIndicator(
                      value: progress,
                      strokeWidth: 7,
                      strokeCap: StrokeCap.round,
                      color: accent,
                      backgroundColor:
                          context.colorScheme.surfaceContainerHighest,
                    ),
                    Center(
                      child: Padding(
                        padding: const EdgeInsets.all(AppSpacing.sm),
                        child: FittedBox(
                          fit: BoxFit.scaleDown,
                          child: Text(
                            CapabilityVisuals.valueText(capability),
                            style: context.textTheme.titleSmall?.copyWith(
                              color: context.colorScheme.onSurface,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ),
                      ),
                    ),
                  ],
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
                    color: accent,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
