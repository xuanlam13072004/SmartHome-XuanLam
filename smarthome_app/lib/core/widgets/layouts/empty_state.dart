import 'package:flutter/material.dart';
import '../../core.dart';
import '../controls/neu_button.dart';
import '../primitives/neu_icon_box.dart';
import '../primitives/neu_container.dart'; // Thêm dòng này

/// Layout hiển thị Empty State
class EmptyState extends StatelessWidget {
  const EmptyState({
    super.key,
    required this.icon,
    required this.title,
    required this.description,
    this.actionText,
    this.onActionTap,
  });

  final IconData icon;
  final String title;
  final String description;
  final String? actionText;
  final VoidCallback? onActionTap;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(AppSpacing.xl),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.center,
        mainAxisSize: MainAxisSize.min,
        children: [
          NeuIconBox(
            icon: icon,
            size: 80,
            iconSize: 40,
            shape: BoxShape.circle,
            depth: NeuDepth.pressed, // Inner shadow tạo cảm giác chìm
            iconColor: context.colorScheme.onSurfaceVariant.withValues(alpha: 0.5),
          ),
          const SizedBox(height: AppSpacing.lg),
          Text(
            title,
            style: context.textTheme.titleLarge,
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: AppSpacing.sm),
          Text(
            description,
            style: context.textTheme.bodyMedium?.copyWith(
              color: context.colorScheme.onSurfaceVariant,
            ),
            textAlign: TextAlign.center,
          ),
          if (actionText != null && onActionTap != null) ...[
            const SizedBox(height: AppSpacing.xl),
            NeuButton.text(
              actionText!,
              onPressed: onActionTap!,
            ),
          ],
        ],
      ),
    );
  }
}
