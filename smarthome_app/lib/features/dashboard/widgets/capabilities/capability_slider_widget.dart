import 'package:flutter/material.dart';
import '../../../../core/core.dart';
import '../../../../core/widgets/widgets.dart';
import '../../models/capability_model.dart';

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
    final unit = props['unit'] as String? ?? '';

    return NeuCard(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.md),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                capability.name,
                style: context.textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w500,
                ),
              ),
              Text(
                '${currentValue.toInt()}$unit',
                style: context.textTheme.bodyLarge?.copyWith(
                  color: context.colorScheme.primary,
                  fontWeight: FontWeight.bold,
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.lg),
          NeuSlider(
            value: currentValue,
            min: min,
            max: max,
            onChanged: capability.isReadOnly ? (_) {} : onChanged,
          ),
          const SizedBox(height: AppSpacing.xs),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text('${min.toInt()}$unit', style: context.textTheme.labelSmall),
              Text('${max.toInt()}$unit', style: context.textTheme.labelSmall),
            ],
          ),
        ],
      ),
    );
  }
}
