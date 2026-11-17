import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/core.dart';
import '../../../core/storage/token_storage_provider.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../providers/account_providers.dart';
import '../widgets/password_field.dart';

Future<void> showChangePasswordSheet(BuildContext context) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (_) => const ChangePasswordSheet(),
  );
}

/// Đổi mật khẩu. This device stays signed in; every other device is signed out.
class ChangePasswordSheet extends ConsumerStatefulWidget {
  const ChangePasswordSheet({super.key});

  @override
  ConsumerState<ChangePasswordSheet> createState() => _ChangePasswordSheetState();
}

class _ChangePasswordSheetState extends ConsumerState<ChangePasswordSheet> {
  final _current = TextEditingController();
  final _next = TextEditingController();
  final _confirm = TextEditingController();
  String? _currentError;
  String? _nextError;
  String? _confirmError;
  String? _formError;
  bool _saving = false;

  @override
  void dispose() {
    _current.dispose();
    _next.dispose();
    _confirm.dispose();
    super.dispose();
  }

  bool _validate() {
    setState(() {
      _currentError = _current.text.isEmpty ? 'Nhập mật khẩu hiện tại' : null;
      _nextError = _next.text.length < 8
          ? 'Mật khẩu mới cần ít nhất 8 ký tự'
          : _next.text == _current.text
              ? 'Mật khẩu mới phải khác mật khẩu hiện tại'
              : null;
      _confirmError = _confirm.text != _next.text ? 'Mật khẩu nhập lại không khớp' : null;
      _formError = null;
    });
    return _currentError == null && _nextError == null && _confirmError == null;
  }

  Future<void> _submit() async {
    if (!_validate()) return;
    setState(() => _saving = true);
    try {
      final result = await ref.read(accountApiProvider).changePassword(
            currentPassword: _current.text,
            newPassword: _next.text,
          );
      await ref.read(tokenStorageProvider).saveAccessToken(result.accessToken);
      ref.invalidate(loginSessionsProvider);
      if (!mounted) return;
      final messenger = ScaffoldMessenger.of(context);
      Navigator.of(context).pop();
      final others = result.signedOutSessions;
      messenger.showSnackBar(SnackBar(
        content: Text(others > 0
            ? 'Đã đổi mật khẩu và đăng xuất $others thiết bị khác'
            : 'Đã đổi mật khẩu'),
      ));
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        final message = AppErrorMapper.mapError(error);
        if (AppErrorMapper.codeOf(error) == 'INVALID_PASSWORD') {
          _currentError = 'Mật khẩu hiện tại không đúng';
        } else {
          _formError = message;
        }
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
            Text('Đổi mật khẩu', style: context.textTheme.titleLarge),
            const SizedBox(height: AppSpacing.xs),
            Text(
              'Máy này vẫn đăng nhập. Các thiết bị khác sẽ bị đăng xuất.',
              style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
            ),
            const SizedBox(height: AppSpacing.md),
            PasswordField(
              controller: _current,
              label: 'Mật khẩu hiện tại',
              errorText: _currentError,
              enabled: !_saving,
              autofocus: true,
            ),
            const SizedBox(height: AppSpacing.md),
            PasswordField(
              controller: _next,
              label: 'Mật khẩu mới',
              helperText: 'Ít nhất 8 ký tự',
              errorText: _nextError,
              enabled: !_saving,
            ),
            const SizedBox(height: AppSpacing.md),
            PasswordField(
              controller: _confirm,
              label: 'Nhập lại mật khẩu mới',
              errorText: _confirmError,
              enabled: !_saving,
              textInputAction: TextInputAction.done,
              onSubmitted: (_) => _submit(),
            ),
            if (_formError != null) ...[
              const SizedBox(height: AppSpacing.sm),
              Text(_formError!, style: TextStyle(color: context.colorScheme.error)),
            ],
            const SizedBox(height: AppSpacing.md),
            FilledButton(
              onPressed: _saving ? null : _submit,
              child: _saving
                  ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Text('Đổi mật khẩu'),
            ),
          ],
        ),
      ),
    );
  }
}
