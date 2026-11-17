import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/core.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../data/sharing_models.dart';
import '../providers/sharing_providers.dart';
import '../widgets/role_choice.dart';

Future<void> showInviteSheet(BuildContext context, DeviceMembers members) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (_) => InviteSheet(members: members),
  );
}

final _emailPattern = RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$');

/// Invite someone by e-mail with a role. They accept in their own app.
class InviteSheet extends ConsumerStatefulWidget {
  const InviteSheet({super.key, required this.members});

  final DeviceMembers members;

  @override
  ConsumerState<InviteSheet> createState() => _InviteSheetState();
}

class _InviteSheetState extends ConsumerState<InviteSheet> {
  final _email = TextEditingController();
  String _role = 'viewer';
  bool _sending = false;
  String? _emailError;
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final email = _email.text.trim().toLowerCase();
    if (!_emailPattern.hasMatch(email)) {
      setState(() => _emailError = 'Email không hợp lệ');
      return;
    }
    setState(() {
      _sending = true;
      _emailError = null;
      _error = null;
    });
    final mac = widget.members.device.mac;
    try {
      await ref.read(sharingApiProvider).invite(mac, email: email, role: _role);
      ref.invalidate(deviceMembersProvider(mac));
      ref.invalidate(sharingOverviewProvider);
      if (!mounted) return;
      final messenger = ScaffoldMessenger.of(context);
      Navigator.of(context).pop();
      messenger.showSnackBar(SnackBar(
        content: Text('Đã gửi lời mời tới $email. Họ sẽ thấy lời mời khi đăng nhập bằng email này.'),
      ));
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _sending = false;
        _error = AppErrorMapper.mapError(error);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(
        AppSpacing.lg,
        0,
        AppSpacing.lg,
        AppSpacing.lg + MediaQuery.viewInsetsOf(context).bottom,
      ),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('Mời người dùng', style: context.textTheme.titleLarge),
            Text(
              'Chia sẻ "${widget.members.device.name}"',
              style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
            ),
            const SizedBox(height: AppSpacing.md),
            TextField(
              controller: _email,
              autofocus: true,
              enabled: !_sending,
              keyboardType: TextInputType.emailAddress,
              autocorrect: false,
              decoration: InputDecoration(
                labelText: 'Email người được mời',
                hintText: 'nguoithan@example.com',
                errorText: _emailError,
                border: const OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: AppSpacing.md),
            Text('Quyền', style: context.textTheme.titleSmall),
            const SizedBox(height: AppSpacing.sm),
            RoleChoice(
              selected: _role,
              rolePermissions: widget.members.rolePermissions,
              enabled: !_sending,
              onChanged: (role) => setState(() => _role = role),
            ),
            if (_error != null) ...[
              const SizedBox(height: AppSpacing.xs),
              Text(_error!, style: TextStyle(color: context.colorScheme.error)),
            ],
            const SizedBox(height: AppSpacing.md),
            FilledButton(
              onPressed: _sending ? null : _send,
              child: _sending
                  ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Text('Gửi lời mời'),
            ),
            const SizedBox(height: AppSpacing.xs),
            Text(
              'Lời mời hết hạn sau 7 ngày. Quyền xóa bản ghi, mã PIN, cài đặt an toàn và gỡ thiết bị luôn chỉ thuộc về bạn.',
              style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
            ),
          ],
        ),
      ),
    );
  }
}
