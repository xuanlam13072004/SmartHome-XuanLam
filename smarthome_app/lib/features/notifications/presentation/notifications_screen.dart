import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons/lucide_icons.dart';

import '../../../core/core.dart';
import '../../../core/navigation/app_routes.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../../core/utils/time_format.dart';
import '../../../core/widgets/widgets.dart';
import '../data/notification_models.dart';
import '../notification_labels.dart';
import '../providers/notification_providers.dart';
import '../widgets/paged_list_view.dart';

/// "Thông báo": warnings and alarms of every device I can see, newest first.
class NotificationsScreen extends ConsumerStatefulWidget {
  const NotificationsScreen({super.key});

  @override
  ConsumerState<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends ConsumerState<NotificationsScreen> {
  bool _markedSeen = false;

  @override
  void initState() {
    super.initState();
    // Once the list is on screen, everything up to now counts as read.
    ref.listenManual<AsyncValue<PagedList<AppNotification>>>(
      notificationsProvider,
      (_, next) {
        if (_markedSeen || !next.hasValue) return;
        _markedSeen = true;
        ref.read(notificationsApiProvider).markSeen().then((_) {
          if (mounted) ref.invalidate(badgesProvider);
        }).catchError((Object _) {});
      },
      fireImmediately: true,
    );
  }

  @override
  Widget build(BuildContext context) {
    final notifications = ref.watch(notificationsProvider);
    return PageScaffold(
      scrollable: false,
      appBar: AppBar(
        title: const Text('Thông báo'),
        actions: [
          IconButton(
            tooltip: 'Loại thông báo',
            icon: const Icon(LucideIcons.settings2),
            onPressed: () => context.push(AppRoutes.profileNotificationSettings),
          ),
        ],
      ),
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
      child: notifications.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => EmptyState(
          icon: LucideIcons.alertTriangle,
          title: 'Không tải được thông báo',
          description: AppErrorMapper.mapError(error),
          actionText: 'Thử lại',
          onActionTap: () => ref.invalidate(notificationsProvider),
        ),
        data: (list) => list.items.isEmpty
            ? RefreshIndicator(
                onRefresh: () async => ref.invalidate(notificationsProvider),
                child: ListView(
                  physics: const AlwaysScrollableScrollPhysics(),
                  children: const [
                    EmptyState(
                      icon: LucideIcons.bellRing,
                      title: 'Chưa có thông báo',
                      description: 'Cảnh báo từ thiết bị (khói, khí gas, sai mã PIN, trời mưa…) '
                          'và thông báo từ tự động hóa của bạn sẽ hiện ở đây.',
                    ),
                  ],
                ),
              )
            : DayGroupedPagedList<AppNotification>(
                list: list,
                timeOf: (item) => item.at,
                onLoadMore: () => ref.read(notificationsProvider.notifier).loadMore(),
                onRefresh: () async {
                  ref.invalidate(notificationsProvider);
                  try {
                    await ref.read(notificationsProvider.future);
                  } catch (_) {}
                },
                itemBuilder: (context, item) => _NotificationTile(item: item),
              ),
      ),
    );
  }
}

class _NotificationTile extends StatelessWidget {
  const _NotificationTile({required this.item});

  final AppNotification item;

  @override
  Widget build(BuildContext context) {
    final color = item.fromAutomation
        ? context.colorScheme.primary
        : item.critical
            ? context.colorScheme.error
            : context.neu.warningColor;
    final icon = item.fromAutomation ? Icons.auto_mode_rounded : NotificationLabels.category(item.category).icon;
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.smMd),
      child: NeuCard(
        padding: EdgeInsets.zero,
        child: InkWell(
          borderRadius: BorderRadius.circular(AppRadius.lg),
          onTap: item.fromAutomation
              ? (item.automationId == null ? null : () => context.push(AppRoutes.automationEditOf(item.automationId!)))
              : item.deviceMac.isEmpty
                  ? null
                  : () => context.push(AppRoutes.deviceDetail.replaceFirst(':mac', item.deviceMac)),
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.md),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  padding: const EdgeInsets.all(AppSpacing.sm),
                  decoration: BoxDecoration(
                    color: color.withValues(alpha: 0.15),
                    shape: BoxShape.circle,
                  ),
                  child: Icon(icon, size: 20, color: color),
                ),
                const SizedBox(width: AppSpacing.md),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        NotificationLabels.notificationTitle(item),
                        style: context.textTheme.bodyLarge?.copyWith(
                          fontWeight: item.unread ? FontWeight.w700 : FontWeight.w500,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        '${item.fromAutomation ? 'Tự động: ${item.title ?? ''}' : item.deviceName} · ${TimeFormat.clock(item.at)}',
                        style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
                      ),
                    ],
                  ),
                ),
                if (item.unread)
                  Container(
                    margin: const EdgeInsets.only(top: 6, left: AppSpacing.sm),
                    width: 8,
                    height: 8,
                    decoration: BoxDecoration(color: context.colorScheme.primary, shape: BoxShape.circle),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
