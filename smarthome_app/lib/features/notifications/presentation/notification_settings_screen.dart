import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons/lucide_icons.dart';

import '../../../core/core.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../../core/widgets/widgets.dart';
import '../notification_labels.dart';
import '../providers/notification_providers.dart';

/// "Loại thông báo": which kinds of warnings to receive. Saved to the account,
/// so the choice follows the user to every device they sign in on.
class NotificationSettingsScreen extends ConsumerStatefulWidget {
  const NotificationSettingsScreen({super.key});

  @override
  ConsumerState<NotificationSettingsScreen> createState() => _NotificationSettingsScreenState();
}

class _NotificationSettingsScreenState extends ConsumerState<NotificationSettingsScreen> {
  Set<String>? _pending;

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
                  'Chọn loại cảnh báo muốn nhận khi đang dùng ứng dụng và trong trang Thông báo.',
                  style: context.textTheme.bodyMedium?.copyWith(color: context.colorScheme.onSurfaceVariant),
                ),
              ),
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
