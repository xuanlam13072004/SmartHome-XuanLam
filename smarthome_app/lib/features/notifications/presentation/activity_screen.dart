import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons/lucide_icons.dart';

import '../../../core/core.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../../core/utils/time_format.dart';
import '../../../core/widgets/widgets.dart';
import '../data/notification_models.dart';
import '../notification_labels.dart';
import '../providers/notification_providers.dart';
import '../widgets/paged_list_view.dart';

/// "Lịch sử hoạt động": what I did — device commands, account changes, sharing.
class ActivityScreen extends ConsumerWidget {
  const ActivityScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final activity = ref.watch(activityProvider);
    return PageScaffold(
      scrollable: false,
      appBar: AppBar(title: const Text('Lịch sử hoạt động')),
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
      child: activity.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => EmptyState(
          icon: LucideIcons.alertTriangle,
          title: 'Không tải được lịch sử',
          description: AppErrorMapper.mapError(error),
          actionText: 'Thử lại',
          onActionTap: () => ref.invalidate(activityProvider),
        ),
        data: (list) => list.items.isEmpty
            ? const EmptyState(
                icon: LucideIcons.history,
                title: 'Chưa có hoạt động',
                description: 'Các thao tác của bạn với thiết bị và tài khoản sẽ được ghi lại ở đây.',
              )
            : DayGroupedPagedList<ActivityItem>(
                list: list,
                timeOf: (item) => item.at,
                onLoadMore: () => ref.read(activityProvider.notifier).loadMore(),
                onRefresh: () async {
                  ref.invalidate(activityProvider);
                  try {
                    await ref.read(activityProvider.future);
                  } catch (_) {}
                },
                itemBuilder: (context, item) => _ActivityTile(item: item),
              ),
      ),
    );
  }
}

class _ActivityTile extends StatelessWidget {
  const _ActivityTile({required this.item});

  final ActivityItem item;

  @override
  Widget build(BuildContext context) {
    final text = ActivityLabels.describe(item);
    final muted = context.colorScheme.onSurfaceVariant;
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.sm),
      child: NeuCard(
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.smMd),
        child: Row(
          children: [
            Icon(text.icon, size: 20, color: text.failed ? context.colorScheme.error : context.colorScheme.primary),
            const SizedBox(width: AppSpacing.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(text.title, style: context.textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w500)),
                  if (text.subtitle.isNotEmpty)
                    Text(text.subtitle, style: context.textTheme.bodySmall?.copyWith(color: muted)),
                ],
              ),
            ),
            const SizedBox(width: AppSpacing.sm),
            Text(TimeFormat.clock(item.at), style: context.textTheme.bodySmall?.copyWith(color: muted)),
          ],
        ),
      ),
    );
  }
}
