import 'package:flutter/material.dart';
import '../../../../core/core.dart';
import '../../../../core/widgets/widgets.dart';
import '../../models/capability_model.dart';
import 'capability_visuals.dart';

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
    final List<String> options =
        (capability.properties['options'] as List<dynamic>?)
                ?.map((e) => e.toString())
                .toList() ??
            [];

    final accent = CapabilityVisuals.accentFor(context, capability);

    return NeuCard(
      padding: const EdgeInsets.all(AppSpacing.md),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          CapabilityHeading(capability: capability),
          const SizedBox(height: AppSpacing.md),
          Wrap(
            spacing: AppSpacing.sm,
            runSpacing: AppSpacing.sm,
            children: options.map((option) {
              final selected = currentValue == option;
              return ChoiceChip(
                selected: selected,
                showCheckmark: false,
                avatar: Icon(
                  CapabilityVisuals.optionIcon(option),
                  size: 18,
                  color: selected
                      ? context.colorScheme.onPrimary
                      : context.colorScheme.onSurfaceVariant,
                ),
                label: Text(CapabilityVisuals.optionLabel(option)),
                onSelected: capability.isReadOnly
                    ? null
                    : (isSelected) {
                        if (isSelected) onChanged(option);
                      },
                selectedColor: accent,
                backgroundColor: context.colorScheme.surfaceContainerLow,
                disabledColor: context.colorScheme.surfaceContainerHighest,
                labelStyle: context.textTheme.labelLarge?.copyWith(
                  color: selected
                      ? context.colorScheme.onPrimary
                      : context.colorScheme.onSurfaceVariant,
                  fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
                ),
                side: BorderSide(
                  color: selected
                      ? Colors.transparent
                      : context.colorScheme.outlineVariant,
                ),
              );
            }).toList(),
          ),
        ],
      ),
    );
  }
}
