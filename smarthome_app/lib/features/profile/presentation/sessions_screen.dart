import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons/lucide_icons.dart';

import '../../../core/core.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../../core/utils/time_format.dart';
import '../../../core/widgets/widgets.dart';
import '../data/account_models.dart';
import '../providers/account_providers.dart';
import '../widgets/confirm_dialog.dart';

/// "Phiên đăng nhập": every device signed in to this account, with sign-out.
class SessionsScreen extends ConsumerWidget {
  const SessionsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sessions = ref.watch(loginSessionsProvider);
    return PageScaffold(
      scrollable: false,
      appBar: AppBar(title: const Text('Phiên đăng nhập')),
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
      child: RefreshIndicator(
        onRefresh: () async {
          ref.invalidate(loginSessionsProvider);
          try {
            await ref.read(loginSessionsProvider.future);
          } catch (_) {}
        },
        child: sessions.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (error, _) => ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            children: [
              EmptyState(
                icon: LucideIcons.alertTriangle,
                title: 'Không tải được danh sách',
                description: AppErrorMapper.mapError(error),
                actionText: 'Thử lại',
                onActionTap: () => ref.invalidate(loginSessionsProvider),
              ),
            ],
          ),
          data: (items) {
            final current = items.where((s) => s.current).toList();
            final others = items.where((s) => !s.current).toList();
            return ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.only(top: AppSpacing.sm, bottom: 120),
              children: [
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm),
                  child: Text(
                    'Các thiết bị đang đăng nhập tài khoản của bạn. Nếu thấy thiết bị lạ, '
                    'hãy đăng xuất nó và đổi mật khẩu.',
                    style: context.textTheme.bodyMedium?.copyWith(color: context.colorScheme.onSurfaceVariant),
                  ),
                ),
                const SizedBox(height: AppSpacing.md),
                for (final session in current) _SessionCard(session: session),
                if (others.isNotEmpty) ...[
                  SectionTitle(
                    title: 'Thiết bị khác (${others.length})',
                    actionText: 'Đăng xuất tất cả',
                    onActionTap: () => _revokeOthers(context, ref, others.length),
                  ),
                  for (final session in others)
                    _SessionCard(session: session, onSignOut: () => _revokeOne(context, ref, session)),
                ] else
                  Padding(
                    padding: const EdgeInsets.all(AppSpacing.md),
                    child: Text(
                      'Không có thiết bị nào khác đang đăng nhập.',
                      textAlign: TextAlign.center,
                      style: context.textTheme.bodyMedium?.copyWith(color: context.colorScheme.onSurfaceVariant),
                    ),
                  ),
              ],
            );
          },
        ),
      ),
    );
  }

  Future<void> _revokeOne(BuildContext context, WidgetRef ref, LoginSession session) async {
    final confirmed = await confirmAction(
      context,
      title: 'Đăng xuất thiết bị này?',
      message: '${session.displayName} sẽ phải đăng nhập lại để dùng tài khoản.',
      confirmLabel: 'Đăng xuất',
      destructive: true,
    );
    if (!confirmed || !context.mounted) return;
    await _run(context, ref, () async {
      await ref.read(accountApiProvider).revokeSession(session.id);
      return 'Đã đăng xuất ${session.displayName}';
    });
  }

  Future<void> _revokeOthers(BuildContext context, WidgetRef ref, int count) async {
    final confirmed = await confirmAction(
      context,
      title: 'Đăng xuất tất cả thiết bị khác?',
      message: '$count thiết bị sẽ phải đăng nhập lại. Máy này vẫn đăng nhập.',
      confirmLabel: 'Đăng xuất tất cả',
      destructive: true,
    );
    if (!confirmed || !context.mounted) return;
    await _run(context, ref, () async {
      final signedOut = await ref.read(accountApiProvider).revokeOtherSessions();
      return 'Đã đăng xuất $signedOut thiết bị';
    });
  }

  Future<void> _run(BuildContext context, WidgetRef ref, Future<String> Function() action) async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      final message = await action();
      messenger.showSnackBar(SnackBar(content: Text(message)));
    } catch (error) {
      messenger.showSnackBar(SnackBar(content: Text(AppErrorMapper.mapError(error))));
    }
    ref.invalidate(loginSessionsProvider);
  }
}

class _SessionCard extends StatelessWidget {
  const _SessionCard({required this.session, this.onSignOut});

  final LoginSession session;
  final VoidCallback? onSignOut;

  IconData get _icon => switch (session.platform) {
        'web' => LucideIcons.globe,
        'android' || 'ios' => LucideIcons.smartphone,
        'windows' || 'linux' => LucideIcons.monitor,
        'macos' => LucideIcons.laptop,
        _ => LucideIcons.helpCircle,
      };

  @override
  Widget build(BuildContext context) {
    final muted = context.colorScheme.onSurfaceVariant;
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.smMd),
      child: NeuCard(
        child: Row(
          children: [
            Icon(_icon, color: session.current ? context.colorScheme.primary : muted),
            const SizedBox(width: AppSpacing.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Flexible(
                        child: Text(
                          session.displayName,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: context.textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w600),
                        ),
                      ),
                      if (session.current) ...[
                        const SizedBox(width: AppSpacing.sm),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                          decoration: BoxDecoration(
                            color: context.colorScheme.primaryContainer,
                            borderRadius: BorderRadius.circular(AppRadius.full),
                          ),
                          child: Text(
                            'Máy này',
                            style: context.textTheme.labelSmall?.copyWith(
                              color: context.colorScheme.onPrimaryContainer,
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                  const SizedBox(height: 2),
                  Text(
                    session.current
                        ? 'Đang hoạt động'
                        : 'Hoạt động ${TimeFormat.relative(session.lastActiveAt).toLowerCase()}',
                    style: context.textTheme.bodySmall?.copyWith(color: muted),
                  ),
                  Text(
                    'Đăng nhập lúc ${TimeFormat.dateTime(session.createdAt)}',
                    style: context.textTheme.bodySmall?.copyWith(color: muted),
                  ),
                ],
              ),
            ),
            if (onSignOut != null)
              TextButton(
                onPressed: onSignOut,
                style: TextButton.styleFrom(foregroundColor: context.colorScheme.error),
                child: const Text('Đăng xuất'),
              ),
          ],
        ),
      ),
    );
  }
}
