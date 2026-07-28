import 'package:flutter/material.dart';
import '../../../../core/core.dart';
import '../../../../core/widgets/widgets.dart';
import '../../models/capability_model.dart';
import 'capability_visuals.dart';

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
      child: CapabilityHeading(
        capability: capability,
        trailing: Flexible(
          child: Text(
            CapabilityVisuals.valueText(capability),
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            textAlign: TextAlign.end,
            style: context.textTheme.titleMedium?.copyWith(
              color: context.colorScheme.primary,
              fontWeight: FontWeight.w700,
            ),
          ),
        ),
      ),
    );
  }
}
