import 'package:flutter/material.dart';
import 'package:lucide_icons/lucide_icons.dart';

import '../../../core/core.dart';
import '../sharing_labels.dart';

/// "Chỉ xem" or "Điều khiển", each listing exactly what it allows on this product.
class RoleChoice extends StatelessWidget {
  const RoleChoice({
    super.key,
    required this.selected,
    required this.rolePermissions,
    required this.onChanged,
    this.enabled = true,
  });

  final String selected;
  final Map<String, List<String>> rolePermissions;
  final ValueChanged<String> onChanged;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        for (final role in const ['viewer', 'controller'])
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.sm),
            child: _RoleCard(
              role: role,
              permissions: rolePermissions[role] ?? const [],
              selected: role == selected,
              onTap: enabled ? () => onChanged(role) : null,
            ),
          ),
      ],
    );
  }
}

class _RoleCard extends StatelessWidget {
  const _RoleCard({
    required this.role,
    required this.permissions,
    required this.selected,
    required this.onTap,
  });

  final String role;
  final List<String> permissions;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = context.colorScheme;
    return Material(
      color: selected ? scheme.primaryContainer.withValues(alpha: 0.5) : scheme.surfaceContainerLow,
      borderRadius: BorderRadius.circular(AppRadius.md),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppRadius.md),
        child: Container(
          padding: const EdgeInsets.all(AppSpacing.md),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(AppRadius.md),
            border: Border.all(
              color: selected ? scheme.primary : scheme.outlineVariant,
              width: selected ? 2 : 1,
            ),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(SharingLabels.roleIcon(role), color: selected ? scheme.primary : scheme.onSurfaceVariant),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(SharingLabels.role(role), style: context.textTheme.titleSmall),
                    Text(
                      SharingLabels.roleDescription(role),
                      style: context.textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
                    ),
                    const SizedBox(height: AppSpacing.xs),
                    for (final scope in permissions)
                      Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: Row(
                          children: [
                            Icon(LucideIcons.check, size: 14, color: scheme.primary),
                            const SizedBox(width: AppSpacing.xs),
                            Expanded(
                              child: Text(SharingLabels.permission(scope), style: context.textTheme.bodySmall),
                            ),
                          ],
                        ),
                      ),
                  ],
                ),
              ),
              Icon(
                selected ? LucideIcons.checkCircle2 : LucideIcons.circle,
                color: selected ? scheme.primary : scheme.outline,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Small rounded label, e.g. the member role.
class RoleChip extends StatelessWidget {
  const RoleChip({super.key, required this.role});

  final String role;

  @override
  Widget build(BuildContext context) {
    final controller = role == 'controller';
    final scheme = context.colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: controller ? scheme.primaryContainer : scheme.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(AppRadius.full),
      ),
      child: Text(
        SharingLabels.role(role),
        style: context.textTheme.labelSmall?.copyWith(
          color: controller ? scheme.onPrimaryContainer : scheme.onSurfaceVariant,
        ),
      ),
    );
  }
}
