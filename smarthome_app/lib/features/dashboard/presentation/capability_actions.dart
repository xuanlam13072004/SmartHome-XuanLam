import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/core.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../../domain/models/device_model.dart';
import '../../auth/providers/auth_provider.dart';
import '../models/capability_model.dart';
import '../providers/devices_provider.dart';

/// Runs one device operation the way the catalog asks: a plain call, a yes/no
/// confirmation first, or the account password first (e.g. unlocking a door).
/// Errors are shown as a snackbar. Used by the device page and room quick controls.
Future<void> applyCapabilityChange(
  BuildContext context,
  WidgetRef ref,
  DeviceModel device,
  CapabilityModel capability,
  dynamic value,
) async {
  final messenger = ScaffoldMessenger.of(context);
  try {
    final operation = capability.resolveOperation(value);
    String? reauthToken;

    if (operation.confirmation == 'confirm') {
      final confirmed = await _confirmOperation(context, operation);
      if (!confirmed) return;
    } else if (operation.confirmation == 'reauthenticate') {
      final password = await requestOwnerPassword(context, operation);
      if (password == null) return;
      reauthToken = await ref.read(authRepositoryProvider).reauthenticate(password);
    }

    await ref.read(devicesProvider.notifier).updateCapability(
          device.mac,
          capability,
          value,
          reauthToken: reauthToken,
        );
  } catch (error) {
    messenger.showSnackBar(
      SnackBar(content: Text(AppErrorMapper.mapError(error))),
    );
  }
}

Future<bool> _confirmOperation(
  BuildContext context,
  CapabilityOperationDescriptor operation,
) async {
  return await showDialog<bool>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: const Text('Xác nhận thao tác'),
          content: Text(
            'Bạn có chắc muốn thực hiện “${operation.label.isEmpty ? operation.operationName : operation.label}”?',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext, false),
              child: const Text('Hủy'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(dialogContext, true),
              child: const Text('Xác nhận'),
            ),
          ],
        ),
      ) ??
      false;
}

/// Asks for the account password before a protected operation.
Future<String?> requestOwnerPassword(
  BuildContext context,
  CapabilityOperationDescriptor operation,
) =>
    requestAccountPassword(
      context,
      message:
          'Thao tác “${operation.label.isEmpty ? operation.operationName : operation.label}” cần nhập lại mật khẩu tài khoản.',
    );

/// Asks for the account password; returns it, or null when cancelled.
Future<String?> requestAccountPassword(BuildContext context, {required String message}) async {
  final controller = TextEditingController();
  try {
    return await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Xác minh chủ sở hữu'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(message),
            const SizedBox(height: AppSpacing.md),
            TextField(
              controller: controller,
              autofocus: true,
              obscureText: true,
              decoration: const InputDecoration(labelText: 'Mật khẩu'),
              onSubmitted: (value) {
                if (value.isNotEmpty) Navigator.pop(dialogContext, value);
              },
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: const Text('Hủy'),
          ),
          FilledButton(
            onPressed: () {
              final password = controller.text;
              if (password.isNotEmpty) Navigator.pop(dialogContext, password);
            },
            child: const Text('Tiếp tục'),
          ),
        ],
      ),
    );
  } finally {
    controller.dispose();
  }
}
