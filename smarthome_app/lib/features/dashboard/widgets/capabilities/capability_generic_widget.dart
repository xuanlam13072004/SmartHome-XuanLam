import 'package:flutter/material.dart';
import '../../../../core/core.dart';
import '../../../../core/widgets/widgets.dart';
import '../../models/capability_model.dart';

/// Generic fallback widget for unknown capability types.
/// Displays capability name and current value as-is to ensure
/// forward compatibility with new backend capabilities.
class CapabilityGenericWidget extends StatelessWidget {
  final CapabilityModel capability;

  const CapabilityGenericWidget({
    super.key,
    required this.capability,
  });

  @override
  Widget build(BuildContext context) {
    return NeuCard(
      padding: const EdgeInsets.all(AppSpacing.md),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  capability.name,
                  style: context.textTheme.bodyLarge?.copyWith(
                    fontWeight: FontWeight.w500,
                  ),
                ),
                const SizedBox(height: AppSpacing.xs),
                Text(
                  '${capability.value ?? '—'}',
                  style: context.textTheme.titleMedium?.copyWith(
                    color: context.colorScheme.primary,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ],
            ),
          ),
          if (capability.properties.containsKey('unit'))
            Text(
              capability.properties['unit'] as String? ?? '',
              style: context.textTheme.bodySmall?.copyWith(
                color: context.colorScheme.onSurfaceVariant,
              ),
            ),
        ],
      ),
    );
  }
}
