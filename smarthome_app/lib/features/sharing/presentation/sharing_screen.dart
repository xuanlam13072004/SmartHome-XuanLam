import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons/lucide_icons.dart';

import '../../../core/core.dart';
import '../../../core/navigation/app_routes.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../../core/utils/time_format.dart';
import '../../../core/widgets/widgets.dart';
import '../../dashboard/providers/devices_provider.dart';
import '../../profile/providers/account_providers.dart';
import '../../profile/widgets/confirm_dialog.dart';
import '../data/sharing_models.dart';
import '../providers/sharing_providers.dart';
import '../widgets/role_choice.dart';

/// "Chia sẻ thiết bị": answer invitations, see what others share with me,
/// and open the sharing settings of my own devices.
class SharingScreen extends ConsumerWidget {
  const SharingScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final overview = ref.watch(sharingOverviewProvider);
    return PageScaffold(
      scrollable: false,
      appBar: AppBar(title: const Text('Chia sẻ thiết bị')),
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
      child: overview.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => EmptyState(
          icon: LucideIcons.alertTriangle,
          title: 'Không tải được thông tin chia sẻ',
          description: AppErrorMapper.mapError(error),
          actionText: 'Thử lại',
          onActionTap: () => ref.invalidate(sharingOverviewProvider),
        ),
        data: (data) => RefreshIndicator(
          onRefresh: () async {
            ref.invalidate(sharingOverviewProvider);
            try {
              await ref.read(sharingOverviewProvider.future);
            } catch (_) {}
          },
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.only(top: AppSpacing.sm, bottom: 120),
            children: [
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm),
                child: Text(
                  'Mời người thân bằng email để họ xem hoặc điều khiển thiết bị của bạn. '
                  'Lời mời gửi cho bạn sẽ hiện ở đây.',
                  style: context.textTheme.bodyMedium?.copyWith(color: context.colorScheme.onSurfaceVariant),
                ),
              ),
              const SizedBox(height: AppSpacing.md),
              if (data.invites.isNotEmpty) ...[
                SectionTitle(title: 'Lời mời đang chờ (${data.invites.length})'),
                for (final invite in data.invites) _ReceivedInviteCard(invite: invite),
                const SizedBox(height: AppSpacing.md),
              ],
              SectionTitle(title: 'Được chia sẻ với tôi (${data.sharedWithMe.length})'),
              if (data.sharedWithMe.isEmpty)
                const _Hint('Chưa có ai chia sẻ thiết bị với bạn.')
              else
                for (final item in data.sharedWithMe) _SharedWithMeCard(item: item),
              const SizedBox(height: AppSpacing.md),
              SectionTitle(title: 'Thiết bị của tôi (${data.myDevices.length})'),
              if (data.myDevices.isEmpty)
                const _Hint('Bạn chưa có thiết bị nào. Thêm thiết bị ở trang Tổng quan rồi chia sẻ tại đây.')
              else
                for (final item in data.myDevices) _MyDeviceCard(item: item),
            ],
          ),
        ),
      ),
    );
  }
}

/// Reloads everything that depends on who can see which device. Takes the
/// invalidate function so callers that leave the screen can pass the container's.
void refreshSharingState(void Function(ProviderOrFamily provider) invalidate) {
  invalidate(sharingOverviewProvider);
  invalidate(accountOverviewProvider);
  invalidate(devicesProvider);
}

class _Hint extends StatelessWidget {
  const _Hint(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.sm),
      child: Text(text, style: context.textTheme.bodyMedium?.copyWith(color: context.colorScheme.onSurfaceVariant)),
    );
  }
}

class _ProductName extends ConsumerWidget {
  const _ProductName(this.productId);

  final String productId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final name = ref.watch(productNameProvider(productId)).valueOrNull ?? '';
    if (name.isEmpty) return const SizedBox.shrink();
    return Text(name, style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant));
  }
}

class _ReceivedInviteCard extends ConsumerStatefulWidget {
  const _ReceivedInviteCard({required this.invite});

  final ReceivedInvite invite;

  @override
  ConsumerState<_ReceivedInviteCard> createState() => _ReceivedInviteCardState();
}

class _ReceivedInviteCardState extends ConsumerState<_ReceivedInviteCard> {
  bool _busy = false;

  Future<void> _answer(bool accept) async {
    setState(() => _busy = true);
    final messenger = ScaffoldMessenger.of(context);
    final api = ref.read(sharingApiProvider);
    final invite = widget.invite;
    try {
      if (accept) {
        await api.acceptInvite(invite.id);
        messenger.showSnackBar(SnackBar(content: Text('Đã thêm "${invite.device.name}" vào danh sách thiết bị')));
      } else {
        await api.declineInvite(invite.id);
        messenger.showSnackBar(const SnackBar(content: Text('Đã từ chối lời mời')));
      }
    } catch (error) {
      messenger.showSnackBar(SnackBar(content: Text(AppErrorMapper.mapError(error))));
      if (mounted) setState(() => _busy = false);
    }
    refreshSharingState(ref.invalidate);
  }

  @override
  Widget build(BuildContext context) {
    final invite = widget.invite;
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.smMd),
      child: NeuCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Icon(LucideIcons.mailOpen, color: context.colorScheme.primary),
                const SizedBox(width: AppSpacing.md),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(invite.device.name, style: context.textTheme.titleMedium),
                      _ProductName(invite.device.productId),
                    ],
                  ),
                ),
                RoleChip(role: invite.role),
              ],
            ),
            const SizedBox(height: AppSpacing.sm),
            Text(
              '${invite.owner.fullName} (${invite.owner.email}) mời bạn. '
              'Hết hạn ${TimeFormat.dateTime(invite.expiresAt)}.',
              style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
            ),
            const SizedBox(height: AppSpacing.sm),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(onPressed: _busy ? null : () => _answer(false), child: const Text('Từ chối')),
                const SizedBox(width: AppSpacing.sm),
                FilledButton(onPressed: _busy ? null : () => _answer(true), child: const Text('Chấp nhận')),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _SharedWithMeCard extends ConsumerWidget {
  const _SharedWithMeCard({required this.item});

  final SharedWithMe item;

  Future<void> _leave(BuildContext context, WidgetRef ref) async {
    final confirmed = await confirmAction(
      context,
      title: 'Rời khỏi thiết bị?',
      message: 'Bạn sẽ không còn thấy "${item.device.name}". Muốn dùng lại, ${item.owner.fullName} phải mời bạn lần nữa.',
      confirmLabel: 'Rời khỏi',
      destructive: true,
    );
    if (!confirmed || !context.mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ref.read(sharingApiProvider).leaveDevice(item.device.mac);
      messenger.showSnackBar(SnackBar(content: Text('Đã rời khỏi "${item.device.name}"')));
    } catch (error) {
      messenger.showSnackBar(SnackBar(content: Text(AppErrorMapper.mapError(error))));
    }
    refreshSharingState(ref.invalidate);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.smMd),
      child: NeuCard(
        child: Row(
          children: [
            Expanded(
              child: InkWell(
                onTap: () => context.push(AppRoutes.deviceDetail.replaceFirst(':mac', item.device.mac)),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Flexible(
                          child: Text(item.device.name, style: context.textTheme.titleMedium, overflow: TextOverflow.ellipsis),
                        ),
                        const SizedBox(width: AppSpacing.sm),
                        RoleChip(role: item.role),
                      ],
                    ),
                    _ProductName(item.device.productId),
                    Text(
                      'Của ${item.owner.fullName}',
                      style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
                    ),
                  ],
                ),
              ),
            ),
            TextButton(
              onPressed: () => _leave(context, ref),
              style: TextButton.styleFrom(foregroundColor: context.colorScheme.error),
              child: const Text('Rời khỏi'),
            ),
          ],
        ),
      ),
    );
  }
}

class _MyDeviceCard extends StatelessWidget {
  const _MyDeviceCard({required this.item});

  final MyDeviceSharing item;

  @override
  Widget build(BuildContext context) {
    final parts = <String>[
      item.memberCount == 0 ? 'Chưa chia sẻ' : '${item.memberCount} người dùng chung',
      if (item.pendingInvites > 0) '${item.pendingInvites} lời mời chờ',
    ];
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.smMd),
      child: NeuCard(
        padding: EdgeInsets.zero,
        child: InkWell(
          onTap: () => context.push(AppRoutes.deviceMembersOf(item.device.mac)),
          borderRadius: BorderRadius.circular(AppRadius.lg),
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.md),
            child: Row(
              children: [
                Icon(
                  item.memberCount > 0 ? LucideIcons.users : LucideIcons.share2,
                  color: item.memberCount > 0 ? context.colorScheme.primary : context.colorScheme.onSurfaceVariant,
                ),
                const SizedBox(width: AppSpacing.md),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(item.device.name, style: context.textTheme.titleMedium),
                      _ProductName(item.device.productId),
                      Text(
                        parts.join(' · '),
                        style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
                      ),
                    ],
                  ),
                ),
                Icon(LucideIcons.chevronRight, size: 16, color: context.colorScheme.onSurfaceVariant),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
