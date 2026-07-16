import 'package:flutter/material.dart';
import '../../../../core/core.dart';
import '../../../../core/widgets/widgets.dart';
import '../../models/capability_model.dart';

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

    return NeuCard(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.sm),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(
            capability.name,
            style: context.textTheme.titleMedium?.copyWith(
              fontWeight: FontWeight.w500,
            ),
          ),
          NeuToggle(
            value: currentValue,
            onChanged: capability.isReadOnly ? (_) {} : onChanged,
          ),
        ],
      ),
    );
  }
}
