import 'package:flutter/material.dart';
import 'package:lucide_icons/lucide_icons.dart';

import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';
import '../data/account_models.dart';

/// Avatar, name, e-mail, membership date and the three account counters.
class ProfileHeader extends StatelessWidget {
  const ProfileHeader({super.key, required this.overview, required this.onEdit});

  final AccountOverview overview;
  final VoidCallback onEdit;

  @override
  Widget build(BuildContext context) {
    final user = overview.user;
    final stats = overview.stats;
    final muted = context.colorScheme.onSurfaceVariant;
    return NeuCard(
      padding: const EdgeInsets.all(AppSpacing.lg),
      child: Column(
        children: [
          Row(
            children: [
              ProfileAvatar(initials: user.initials),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      user.fullName,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: context.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      user.email,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: context.textTheme.bodyMedium?.copyWith(color: muted),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      'Thành viên từ tháng ${user.createdAt.month}/${user.createdAt.year}',
                      style: context.textTheme.bodySmall?.copyWith(color: muted),
                    ),
                  ],
                ),
              ),
              IconButton(
                tooltip: 'Sửa họ tên',
                onPressed: onEdit,
                icon: const Icon(LucideIcons.pencil, size: 20),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.lg),
          Row(
            children: [
              Expanded(child: _StatTile(value: stats.ownedDevices, label: 'Thiết bị của tôi')),
              const SizedBox(width: AppSpacing.sm),
              Expanded(child: _StatTile(value: stats.sharedDevices, label: 'Được chia sẻ')),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: _StatTile(
                  value: stats.pendingInvites,
                  label: 'Lời mời chờ',
                  highlight: stats.pendingInvites > 0,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class ProfileAvatar extends StatelessWidget {
  const ProfileAvatar({super.key, required this.initials, this.size = 64});

  final String initials;
  final double size;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: context.colorScheme.primaryContainer,
      ),
      child: Text(
        initials,
        style: context.textTheme.titleLarge?.copyWith(
          color: context.colorScheme.onPrimaryContainer,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

class _StatTile extends StatelessWidget {
  const _StatTile({required this.value, required this.label, this.highlight = false});

  final int value;
  final String label;
  final bool highlight;

  @override
  Widget build(BuildContext context) {
    final scheme = context.colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.smMd, horizontal: AppSpacing.xs),
      decoration: BoxDecoration(
        color: highlight ? scheme.primaryContainer : scheme.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(AppRadius.md),
      ),
      child: Column(
        children: [
          Text(
            '$value',
            style: context.textTheme.titleLarge?.copyWith(
              fontWeight: FontWeight.w700,
              color: highlight ? scheme.onPrimaryContainer : scheme.onSurface,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: context.textTheme.labelSmall?.copyWith(
              color: highlight ? scheme.onPrimaryContainer : scheme.onSurfaceVariant,
            ),
          ),
        ],
      ),
    );
  }
}
