import 'package:flutter/material.dart';
import '../../../../core/core.dart';
import '../../../../core/widgets/widgets.dart';
import '../../models/capability_model.dart';

class CapabilityModeWidget extends StatelessWidget {
  const CapabilityModeWidget({
    super.key,
    required this.capability,
    required this.onChanged,
  });

  final CapabilityModel capability;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    final String currentValue = (capability.value as String?) ?? '';
    final List<String> options = (capability.properties['options'] as List<dynamic>?)
            ?.map((e) => e.toString())
            .toList() ?? [];

    return NeuCard(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.md),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            capability.name,
            style: context.textTheme.titleMedium?.copyWith(
              fontWeight: FontWeight.w500,
            ),
          ),
          const SizedBox(height: AppSpacing.md),
          Wrap(
            spacing: AppSpacing.sm,
            runSpacing: AppSpacing.sm,
            children: options.map((option) {
              return NeuChip(
                label: option,
                isSelected: currentValue == option,
                onSelected: capability.isReadOnly
                    ? (_) {}
                    : (selected) {
                        if (selected) onChanged(option);
                      },
              );
            }).toList(),
          ),
        ],
      ),
    );
  }
}
