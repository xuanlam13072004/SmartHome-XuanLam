import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons/lucide_icons.dart';

import '../../../core/core.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../../core/utils/time_format.dart';
import '../../../core/widgets/widgets.dart';
import '../../profile/data/account_models.dart';
import '../../profile/widgets/confirm_dialog.dart';
import '../../profile/widgets/profile_header.dart';
import '../data/sharing_models.dart';
import '../providers/sharing_providers.dart';
import '../widgets/role_choice.dart';
import 'invite_sheet.dart';
import 'member_sheet.dart';

/// Owner view of who can use one device: members, open invitations, invite.
class DeviceMembersScreen extends ConsumerWidget {
  const DeviceMembersScreen({super.key, required this.mac});

  final String mac;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final members = ref.watch(deviceMembersProvider(mac));
    return PageScaffold(
      scrollable: false,
      appBar: AppBar(title: const Text('Chia sẻ thiết bị')),
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
      child: members.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => EmptyState(
          icon: LucideIcons.alertTriangle,
          title: 'Không tải được danh sách',
          description: AppErrorMapper.mapError(error),
          actionText: 'Thử lại',
          onActionTap: () => ref.invalidate(deviceMembersProvider(mac)),
        ),
        data: (data) => RefreshIndicator(
          onRefresh: () async {
            ref.invalidate(deviceMembersProvider(mac));
            try {
              await ref.read(deviceMembersProvider(mac).future);
            } catch (_) {}
          },
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.only(top: AppSpacing.sm, bottom: 120),
            children: [
              NeuCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(data.device.name, style: context.textTheme.titleLarge),
                    const SizedBox(height: 2),
                    Text(
                      'Đang dùng ${data.used}/${data.maxMembers} chỗ chia sẻ',
                      style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
                    ),
                    const SizedBox(height: AppSpacing.md),
                    FilledButton.icon(
                      onPressed: data.isFull ? null : () => showInviteSheet(context, data),
                      icon: const Icon(LucideIcons.userPlus, size: 18),
                      label: const Text('Mời người dùng'),
                    ),
                    if (data.isFull)
                      Padding(
                        padding: const EdgeInsets.only(top: AppSpacing.xs),
                        child: Text(
                          'Đã đủ ${data.maxMembers} người. Xóa bớt người hoặc hủy lời mời để mời thêm.',
                          style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.error),
                        ),
                      ),
                  ],
                ),
              ),
              const SizedBox(height: AppSpacing.md),
              SectionTitle(title: 'Người được chia sẻ (${data.members.length})'),
              if (data.members.isEmpty)
                const _Hint('Chưa chia sẻ với ai. Nhấn "Mời người dùng" để mời người thân.')
              else
                for (final member in data.members)
                  _MemberCard(member: member, onTap: () => showMemberSheet(context, data, member)),
              if (data.invites.isNotEmpty) ...[
                const SizedBox(height: AppSpacing.md),
                SectionTitle(title: 'Lời mời đang chờ (${data.invites.length})'),
                for (final invite in data.invites)
                  _InviteCard(invite: invite, onCancel: () => _cancel(context, ref, invite)),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _cancel(BuildContext context, WidgetRef ref, SentInvite invite) async {
    final confirmed = await confirmAction(
      context,
      title: 'Hủy lời mời?',
      message: '${invite.email} sẽ không thể chấp nhận lời mời này nữa.',
      confirmLabel: 'Hủy lời mời',
      destructive: true,
    );
    if (!confirmed || !context.mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ref.read(sharingApiProvider).cancelInvite(mac, invite.id);
      messenger.showSnackBar(SnackBar(content: Text('Đã hủy lời mời tới ${invite.email}')));
    } catch (error) {
      messenger.showSnackBar(SnackBar(content: Text(AppErrorMapper.mapError(error))));
    }
    ref.invalidate(deviceMembersProvider(mac));
    ref.invalidate(sharingOverviewProvider);
  }
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

class _MemberCard extends StatelessWidget {
  const _MemberCard({required this.member, required this.onTap});

  final DeviceMember member;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.smMd),
      child: NeuCard(
        padding: EdgeInsets.zero,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(AppRadius.lg),
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.md),
            child: Row(
              children: [
                ProfileAvatar(initials: initialsOf(member.fullName), size: 40),
                const SizedBox(width: AppSpacing.md),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(member.fullName, style: context.textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w600)),
                      Text(
                        member.email,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
                      ),
                    ],
                  ),
                ),
                RoleChip(role: member.role),
                const SizedBox(width: AppSpacing.xs),
                Icon(LucideIcons.chevronRight, size: 16, color: context.colorScheme.onSurfaceVariant),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _InviteCard extends StatelessWidget {
  const _InviteCard({required this.invite, required this.onCancel});

  final SentInvite invite;
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.smMd),
      child: NeuCard(
        child: Row(
          children: [
            Icon(LucideIcons.mail, color: context.colorScheme.onSurfaceVariant),
            const SizedBox(width: AppSpacing.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(invite.email, maxLines: 1, overflow: TextOverflow.ellipsis, style: context.textTheme.bodyLarge),
                  const SizedBox(height: 2),
                  Row(
                    children: [
                      RoleChip(role: invite.role),
                      const SizedBox(width: AppSpacing.sm),
                      Flexible(
                        child: Text(
                          'Hết hạn ${TimeFormat.dateTime(invite.expiresAt)}',
                          style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            TextButton(
              onPressed: onCancel,
              style: TextButton.styleFrom(foregroundColor: context.colorScheme.error),
              child: const Text('Hủy'),
            ),
          ],
        ),
      ),
    );
  }
}
