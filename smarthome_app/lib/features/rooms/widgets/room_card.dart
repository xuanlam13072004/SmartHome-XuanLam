import 'package:flutter/material.dart';

import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';
import '../room_insights.dart';

/// Small pills with a room's live facts ("31°C", "Đã khóa").
class RoomReadingPills extends StatelessWidget {
  const RoomReadingPills({super.key, required this.readings, this.max = 3, this.singleLine = false});

  final List<RoomReading> readings;
  final int max;

  /// Keeps to one line (fixed-height cards); pills that do not fit are hidden.
  final bool singleLine;

  @override
  Widget build(BuildContext context) {
    if (readings.isEmpty) return const SizedBox.shrink();
    final scheme = context.colorScheme;
    final pills = Wrap(
      spacing: AppSpacing.xs,
      runSpacing: AppSpacing.xs,
      clipBehavior: singleLine ? Clip.hardEdge : Clip.none,
      children: [
        for (final reading in readings.take(max))
          Container(
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm, vertical: 3),
            decoration: BoxDecoration(
              color: (reading.warning ? context.neu.warningColor : scheme.primary).withValues(alpha: 0.1),
              borderRadius: BorderRadius.circular(AppRadius.full),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  reading.icon,
                  size: 13,
                  color: reading.warning ? context.neu.warningColor : scheme.primary,
                ),
                const SizedBox(width: 4),
                Text(
                  reading.label,
                  style: context.textTheme.labelSmall?.copyWith(fontWeight: FontWeight.w700),
                ),
              ],
            ),
          ),
      ],
    );
    return singleLine ? SizedBox(height: 24, child: pills) : pills;
  }
}

/// "1 cảnh báo" badge, shown only when something in the room needs attention.
class RoomAlertBadge extends StatelessWidget {
  const RoomAlertBadge({super.key, required this.count});

  final int count;

  @override
  Widget build(BuildContext context) {
    final error = context.colorScheme.error;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm, vertical: 3),
      decoration: BoxDecoration(
        color: error.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(AppRadius.full),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.warning_amber_rounded, size: 13, color: error),
          const SizedBox(width: 4),
          Text(
            '$count cảnh báo',
            style: context.textTheme.labelSmall?.copyWith(color: error, fontWeight: FontWeight.w800),
          ),
        ],
      ),
    );
  }
}

/// A room on the "Phòng" page: what it is, how many devices, and how it is now.
class RoomCard extends StatelessWidget {
  const RoomCard({
    super.key,
    required this.icon,
    required this.name,
    required this.summary,
    required this.onTap,
    this.menu,
  });

  final IconData icon;
  final String name;
  final RoomSummary summary;
  final VoidCallback onTap;

  /// Edit / delete, absent for the "Chưa xếp phòng" group.
  final Widget? menu;

  @override
  Widget build(BuildContext context) {
    final scheme = context.colorScheme;
    final alert = summary.alerts > 0;
    return Semantics(
      button: true,
      label: '$name, ${summary.countLabel}${alert ? ', ${summary.alerts} cảnh báo' : ''}',
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: NeuCard(
          padding: const EdgeInsets.all(AppSpacing.md),
          glowColor: alert ? scheme.error : null,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  NeuIconBox(
                    icon: icon,
                    size: 42,
                    iconSize: 21,
                    isActive: summary.online > 0,
                    iconColor: alert ? scheme.error : null,
                    activeIconColor: alert ? scheme.error : scheme.primary,
                  ),
                  const Spacer(),
                  if (menu != null) menu!,
                ],
              ),
              const SizedBox(height: AppSpacing.smMd),
              ExcludeSemantics(
                child: Text(
                  name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: context.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
                ),
              ),
              const SizedBox(height: 2),
              ExcludeSemantics(
                child: Text(
                  summary.countLabel,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: context.textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
                ),
              ),
              const Spacer(),
              if (alert) ...[
                RoomAlertBadge(count: summary.alerts),
                const SizedBox(height: AppSpacing.xs),
              ],
              RoomReadingPills(readings: summary.readings, max: 3, singleLine: true),
            ],
          ),
        ),
      ),
    );
  }
}
