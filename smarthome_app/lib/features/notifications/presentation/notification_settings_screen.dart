import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons/lucide_icons.dart';

import '../../../core/core.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../../core/widgets/widgets.dart';
import '../../push/push_notifications.dart';
import '../notification_labels.dart';
import '../providers/notification_providers.dart';

/// "Loại thông báo": which kinds of warnings to receive. Saved to the account,
/// so the choice follows the user to every device they sign in on. Also shows
/// whether push notifications work on this phone, with a test button.
class NotificationSettingsScreen extends ConsumerStatefulWidget {
  const NotificationSettingsScreen({super.key});

  @override
  ConsumerState<NotificationSettingsScreen> createState() => _NotificationSettingsScreenState();
}

class _NotificationSettingsScreenState extends ConsumerState<NotificationSettingsScreen> {
  Set<String>? _pending;
  bool _testing = false;

  @override
  void initState() {
    super.initState();
    // Retries after the user allowed notifications in the phone's settings.
    final push = ref.read(pushNotificationsProvider);
    if (push.status == PushStatus.denied || push.status == PushStatus.idle) unawaited(push.start());
  }

  Future<void> _sendTest() async {
    setState(() => _testing = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ref.read(pushNotificationsProvider).sendTest();
      messenger.showSnackBar(const SnackBar(content: Text('Đã gửi. Thông báo sẽ hiện trên thanh trạng thái của máy.')));
    } catch (error) {
      messenger.showSnackBar(SnackBar(content: Text(AppErrorMapper.mapError(error))));
    }
    if (mounted) setState(() => _testing = false);
  }

  Future<void> _toggle(Set<String> muted, String category, bool enabled) async {
    final next = {...muted};
    enabled ? next.remove(category) : next.add(category);
    setState(() => _pending = next);
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ref.read(notificationsApiProvider).updateMutedCategories(next);
      ref.invalidate(mutedCategoriesProvider);
      ref.invalidate(badgesProvider);
      ref.invalidate(notificationsProvider);
    } catch (error) {
      messenger.showSnackBar(SnackBar(content: Text(AppErrorMapper.mapError(error))));
    }
    if (mounted) setState(() => _pending = null);
  }

  @override
  Widget build(BuildContext context) {
    final muted = ref.watch(mutedCategoriesProvider);
    return PageScaffold(
      scrollable: false,
      appBar: AppBar(title: const Text('Loại thông báo')),
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
      child: muted.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => EmptyState(
          icon: LucideIcons.alertTriangle,
          title: 'Không tải được cài đặt',
          description: AppErrorMapper.mapError(error),
          actionText: 'Thử lại',
          onActionTap: () => ref.invalidate(mutedCategoriesProvider),
        ),
        data: (saved) {
          final current = _pending ?? saved;
          return ListView(
            padding: const EdgeInsets.only(top: AppSpacing.sm, bottom: 120),
            children: [
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm),
                child: Text(
                  'Chọn loại cảnh báo muốn nhận: trong ứng dụng, trong trang Thông báo và qua thông báo đẩy khi ứng dụng đang tắt.',
                  style: context.textTheme.bodyMedium?.copyWith(color: context.colorScheme.onSurfaceVariant),
                ),
              ),
              const SizedBox(height: AppSpacing.md),
              _PushCard(testing: _testing, onTest: _sendTest),
              const SizedBox(height: AppSpacing.md),
              NeuCard(
                padding: EdgeInsets.zero,
                child: Column(
                  children: [
                    for (final category in NotificationLabels.categories)
                      SwitchListTile(
                        secondary: Icon(category.icon),
                        title: Text(category.label),
                        subtitle: Text(category.locked ? '${category.description}. Luôn bật để đảm bảo an toàn.'
                            : category.description),
                        value: category.locked || !current.contains(category.id),
                        onChanged: category.locked || _pending != null
                            ? null
                            : (enabled) => _toggle(current, category.id, enabled),
                      ),
                  ],
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

/// Whether this phone receives notifications while the app is closed.
class _PushCard extends ConsumerWidget {
  const _PushCard({required this.testing, required this.onTest});

  final bool testing;
  final VoidCallback onTest;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final push = ref.watch(pushNotificationsProvider);
    final (icon, title, detail, ok) = switch (push.status) {
      PushStatus.enabled when push.serverReady =>
        (LucideIcons.bellRing, 'Thông báo đẩy đang bật', 'Cảnh báo vẫn đến khi ứng dụng đang tắt.', true),
      PushStatus.enabled =>
        (LucideIcons.bellOff, 'Máy chủ chưa bật thông báo đẩy', 'Cần cấu hình Firebase trên máy chủ (secrets/).', false),
      PushStatus.denied => (
          LucideIcons.bellOff,
          'Thông báo đang bị tắt',
          'Bật lại trong Cài đặt của điện thoại → Ứng dụng → SmartHome → Thông báo.',
          false,
        ),
      PushStatus.notConfigured =>
        (LucideIcons.bellOff, 'Bản ứng dụng này chưa có cấu hình Firebase', 'Chỉ nhận cảnh báo khi đang mở ứng dụng.', false),
      PushStatus.unsupported =>
        (LucideIcons.bellOff, 'Không hỗ trợ trên nền tảng này', 'Thông báo đẩy có trên Android và iOS.', false),
      PushStatus.idle => (LucideIcons.bell, 'Đang kiểm tra thông báo đẩy…', '', false),
    };
    return NeuCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Icon(icon, color: ok ? context.neu.successColor : context.colorScheme.onSurfaceVariant),
              const SizedBox(width: AppSpacing.sm),
              Expanded(child: Text(title, style: context.textTheme.titleSmall)),
            ],
          ),
          if (detail.isNotEmpty) ...[
            const SizedBox(height: AppSpacing.xs),
            Text(detail, style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant)),
          ],
          if (ok) ...[
            const SizedBox(height: AppSpacing.sm),
            Align(
              alignment: Alignment.centerLeft,
              child: OutlinedButton.icon(
                onPressed: testing ? null : onTest,
                icon: const Icon(LucideIcons.send, size: 16),
                label: const Text('Gửi thông báo thử'),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
