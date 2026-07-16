import 'package:flutter/material.dart';
import '../../../../core/core.dart';
import '../../../../core/widgets/widgets.dart';
import '../../models/capability_model.dart';

class CapabilitySensorWidget extends StatelessWidget {
  const CapabilitySensorWidget({
    super.key,
    required this.capability,
  });

  final CapabilityModel capability;

  @override
  Widget build(BuildContext context) {
    final value = capability.value;
    final unit = capability.properties['unit'] as String? ?? '';

    return NeuCard(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.md),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(
            capability.name,
            style: context.textTheme.titleMedium?.copyWith(
              fontWeight: FontWeight.w500,
            ),
          ),
          Text(
            '$value$unit',
            style: context.textTheme.titleMedium?.copyWith(
              fontWeight: FontWeight.bold,
              color: context.colorScheme.primary,
            ),
          ),
        ],
      ),
    );
  }
}
