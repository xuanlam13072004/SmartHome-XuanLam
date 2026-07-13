import 'package:flutter/material.dart';
import '../../core.dart';
import '../primitives/neu_container.dart';

/// Chip Neumorphic. 
/// Dùng cho bộ lọc, lựa chọn phân loại (Room, Category).
class NeuChip extends StatelessWidget {
  const NeuChip({
    super.key,
    required this.label,
    required this.isSelected,
    required this.onSelected,
  });

  final String label;
  final bool isSelected;
  final ValueChanged<bool> onSelected;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: () => onSelected(!isSelected),
      behavior: HitTestBehavior.opaque,
      child: NeuContainer(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.md,
          vertical: AppSpacing.sm,
        ),
        borderRadius: AppRadius.full,
        depth: isSelected ? NeuDepth.pressed : NeuDepth.raisedSubtle,
        color: isSelected 
            ? context.colorScheme.primary.withValues(alpha: 0.1) 
            : null,
        child: AnimatedDefaultTextStyle(
          duration: const Duration(milliseconds: 150),
          style: context.textTheme.labelLarge!.copyWith(
            color: isSelected 
                ? context.colorScheme.primary 
                : context.colorScheme.onSurfaceVariant,
            fontWeight: isSelected ? FontWeight.w600 : FontWeight.w500,
          ),
          child: Text(label),
        ),
      ),
    );
  }
}
