import 'package:flutter/material.dart';
import '../../../../core/core.dart';
import '../../../../core/widgets/widgets.dart';
import '../../models/capability_model.dart';
import 'capability_visuals.dart';

class CapabilityToggleWidget extends StatelessWidget {
  const CapabilityToggleWidget({
    super.key,
    required this.capability,
    required this.onChanged,
  });

  final CapabilityModel capability;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    // Ép kiểu an toàn (phòng trường hợp backend trả sai type)
    final bool currentValue = (capability.value as bool?) ?? false;

    final accent = CapabilityVisuals.accentFor(context, capability);
    final background = currentValue
        ? Color.alphaBlend(
            accent.withValues(alpha: 0.08),
            context.neu.surface,
          )
        : context.neu.surface;

    return Semantics(
      container: true,
      toggled: currentValue,
      enabled: !capability.isReadOnly,
      label: capability.name,
      value: currentValue ? 'Bật' : 'Tắt',
      child: NeuCard(
        color: background,
        padding: const EdgeInsets.all(AppSpacing.md),
        child: CapabilityHeading(
          capability: capability,
          subtitle: currentValue ? 'Đang bật' : 'Đang tắt',
          trailing: NeuToggle(
            value: currentValue,
            isDisabled: capability.isReadOnly,
            onChanged: onChanged,
          ),
        ),
      ),
    );
  }
}
