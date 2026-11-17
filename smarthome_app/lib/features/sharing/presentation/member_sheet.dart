import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons/lucide_icons.dart';

import '../../../core/core.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../../core/utils/time_format.dart';
import '../../profile/data/account_models.dart';
import '../../profile/widgets/confirm_dialog.dart';
import '../../profile/widgets/profile_header.dart';
import '../data/sharing_models.dart';
import '../providers/sharing_providers.dart';
import '../widgets/role_choice.dart';

Future<void> showMemberSheet(BuildContext context, DeviceMembers members, DeviceMember member) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (_) => MemberSheet(members: members, member: member),
  );
}

/// Change a member's role or remove their access.
class MemberSheet extends ConsumerStatefulWidget {
  const MemberSheet({super.key, required this.members, required this.member});

  final DeviceMembers members;
  final DeviceMember member;

  @override
  ConsumerState<MemberSheet> createState() => _MemberSheetState();
}

class _MemberSheetState extends ConsumerState<MemberSheet> {
  late String _role = widget.member.role;
  bool _busy = false;
  String? _error;

  String get _mac => widget.members.device.mac;

  Future<void> _run(Future<void> Function() action, String done) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await action();
      ref.invalidate(deviceMembersProvider(_mac));
      ref.invalidate(sharingOverviewProvider);
      if (!mounted) return;
      final messenger = ScaffoldMessenger.of(context);
      Navigator.of(context).pop();
      messenger.showSnackBar(SnackBar(content: Text(done)));
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = AppErrorMapper.mapError(error);
      });
    }
  }

  Future<void> _remove() async {
    final confirmed = await confirmAction(
      context,
      title: 'Xóa quyền truy cập?',
      message: '${widget.member.fullName} sẽ không còn thấy và điều khiển "${widget.members.device.name}".',
      confirmLabel: 'Xóa quyền',
      destructive: true,
    );
    if (!confirmed) return;
    await _run(
      () => ref.read(sharingApiProvider).removeMember(_mac, widget.member.accountId),
      'Đã xóa quyền của ${widget.member.fullName}',
    );
  }

  @override
  Widget build(BuildContext context) {
    final member = widget.member;
    return Padding(
      padding: const EdgeInsets.fromLTRB(AppSpacing.lg, 0, AppSpacing.lg, AppSpacing.lg),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                ProfileAvatar(initials: initialsOf(member.fullName), size: 48),
                const SizedBox(width: AppSpacing.md),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(member.fullName, style: context.textTheme.titleMedium),
                      Text(
                        '${member.email} · tham gia ${TimeFormat.dateTime(member.joinedAt)}',
                        style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.md),
            RoleChoice(
              selected: _role,
              rolePermissions: widget.members.rolePermissions,
              enabled: !_busy,
              onChanged: (role) => setState(() => _role = role),
            ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(bottom: AppSpacing.sm),
                child: Text(_error!, style: TextStyle(color: context.colorScheme.error)),
              ),
            FilledButton(
              onPressed: _busy || _role == member.role
                  ? null
                  : () => _run(
                        () => ref.read(sharingApiProvider).changeRole(_mac, member.accountId, _role),
                        'Đã cập nhật quyền của ${member.fullName}',
                      ),
              child: const Text('Lưu quyền'),
            ),
            const SizedBox(height: AppSpacing.sm),
            OutlinedButton.icon(
              onPressed: _busy ? null : _remove,
              style: OutlinedButton.styleFrom(foregroundColor: context.colorScheme.error),
              icon: const Icon(LucideIcons.userMinus, size: 18),
              label: const Text('Xóa quyền truy cập'),
            ),
          ],
        ),
      ),
    );
  }
}
