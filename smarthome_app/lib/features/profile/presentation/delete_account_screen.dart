import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons/lucide_icons.dart';

import '../../../core/core.dart';
import '../../../core/navigation/app_routes.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../../core/widgets/widgets.dart';
import '../../auth/providers/auth_provider.dart';
import '../providers/account_providers.dart';
import '../widgets/password_field.dart';

/// "Xóa tài khoản": explains what is lost, requires removing owned devices
/// first, then the password and an explicit confirmation.
class DeleteAccountScreen extends ConsumerStatefulWidget {
  const DeleteAccountScreen({super.key});

  @override
  ConsumerState<DeleteAccountScreen> createState() => _DeleteAccountScreenState();
}

class _DeleteAccountScreenState extends ConsumerState<DeleteAccountScreen> {
  final _password = TextEditingController();
  bool _understood = false;
  bool _deleting = false;
  String? _passwordError;
  String? _error;

  @override
  void dispose() {
    _password.dispose();
    super.dispose();
  }

  Future<void> _delete() async {
    if (_password.text.isEmpty) {
      setState(() => _passwordError = 'Nhập mật khẩu để xác nhận');
      return;
    }
    setState(() {
      _deleting = true;
      _passwordError = null;
      _error = null;
    });
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ref.read(accountApiProvider).deleteAccount(password: _password.text);
      await ref.read(authControllerProvider.notifier).signOutLocally();
      messenger.showSnackBar(const SnackBar(content: Text('Tài khoản của bạn đã được xóa')));
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _deleting = false;
        if (AppErrorMapper.codeOf(error) == 'INVALID_PASSWORD') {
          _passwordError = 'Mật khẩu không đúng';
        } else {
          _error = AppErrorMapper.mapError(error);
        }
      });
      if (AppErrorMapper.codeOf(error) == 'ACCOUNT_OWNS_DEVICES') {
        ref.invalidate(accountOverviewProvider);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final overview = ref.watch(accountOverviewProvider);
    final owned = overview.valueOrNull?.stats.ownedDevices;

    return PageScaffold(
      scrollable: false,
      appBar: AppBar(title: const Text('Xóa tài khoản')),
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
      child: ListView(
        padding: const EdgeInsets.only(top: AppSpacing.sm, bottom: 120),
        children: [
          NeuCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Icon(LucideIcons.alertTriangle, color: context.colorScheme.error),
                    const SizedBox(width: AppSpacing.sm),
                    Text('Không thể hoàn tác', style: context.textTheme.titleMedium),
                  ],
                ),
                const SizedBox(height: AppSpacing.sm),
                for (final line in const [
                  'Hồ sơ, phiên đăng nhập và cài đặt của bạn bị xóa vĩnh viễn.',
                  'Quyền bạn được chia sẻ trên thiết bị của người khác bị thu hồi.',
                  'Các lời mời đang chờ gửi tới email này bị hủy.',
                ])
                  Padding(
                    padding: const EdgeInsets.only(top: AppSpacing.xs),
                    child: Text('•  $line', style: context.textTheme.bodyMedium),
                  ),
              ],
            ),
          ),
          const SizedBox(height: AppSpacing.lg),
          if (overview.isLoading)
            const Center(child: CircularProgressIndicator())
          else if (owned == null)
            EmptyState(
              icon: LucideIcons.alertTriangle,
              title: 'Không kiểm tra được thiết bị',
              description: AppErrorMapper.mapError(overview.error),
              actionText: 'Thử lại',
              onActionTap: () => ref.invalidate(accountOverviewProvider),
            )
          else if (owned > 0)
            NeuCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    'Bạn đang sở hữu $owned thiết bị',
                    style: context.textTheme.titleMedium,
                  ),
                  const SizedBox(height: AppSpacing.xs),
                  Text(
                    'Hãy gỡ từng thiết bị trước (mở thiết bị → menu → Xóa thiết bị). '
                    'Gỡ thiết bị sẽ đưa nó về trạng thái xuất xưởng và xóa bản ghi camera.',
                    style: context.textTheme.bodyMedium?.copyWith(color: context.colorScheme.onSurfaceVariant),
                  ),
                  const SizedBox(height: AppSpacing.md),
                  OutlinedButton.icon(
                    onPressed: () => context.go(AppRoutes.dashboard),
                    icon: const Icon(LucideIcons.layoutDashboard, size: 18),
                    label: const Text('Đến trang Tổng quan'),
                  ),
                ],
              ),
            )
          else ...[
            PasswordField(
              controller: _password,
              label: 'Mật khẩu',
              errorText: _passwordError,
              enabled: !_deleting,
              textInputAction: TextInputAction.done,
            ),
            const SizedBox(height: AppSpacing.sm),
            CheckboxListTile(
              value: _understood,
              onChanged: _deleting ? null : (value) => setState(() => _understood = value ?? false),
              controlAffinity: ListTileControlAffinity.leading,
              contentPadding: EdgeInsets.zero,
              title: const Text('Tôi hiểu tài khoản sẽ bị xóa vĩnh viễn'),
            ),
            if (_error != null) ...[
              const SizedBox(height: AppSpacing.sm),
              Text(_error!, style: TextStyle(color: context.colorScheme.error)),
            ],
            const SizedBox(height: AppSpacing.md),
            FilledButton(
              style: FilledButton.styleFrom(
                backgroundColor: context.colorScheme.error,
                foregroundColor: context.colorScheme.onError,
              ),
              onPressed: _understood && !_deleting ? _delete : null,
              child: _deleting
                  ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Text('Xóa tài khoản vĩnh viễn'),
            ),
          ],
        ],
      ),
    );
  }
}
