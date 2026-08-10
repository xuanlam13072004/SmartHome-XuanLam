// Hallmark · pre-emit critique: P5 H5 E4 S5 R4 V5
// Hallmark · modern-minimal · calm precision · device hero → alerts → controls → sensors
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';
import '../../products/product_ui_registry.dart';
import '../providers/devices_provider.dart';
import '../../../domain/models/device_model.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../auth/providers/auth_provider.dart';
import '../models/capability_model.dart';
import '../../../domain/models/product_model.dart';

class DeviceDetailScreen extends ConsumerWidget {
  const DeviceDetailScreen({
    super.key,
    required this.deviceMac,
  });

  final String deviceMac;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final devicesAsync = ref.watch(devicesProvider);

    return devicesAsync.when(
      loading: () => const PageScaffold(
        appBar: null,
        child: Center(child: CircularProgressIndicator()),
      ),
      error: (err, stack) => const PageScaffold(
        appBar: null,
        child: Center(child: Text('Không thể tải thông tin thiết bị')),
      ),
      data: (devices) {
        final deviceIndex = devices.indexWhere((d) => d.mac == deviceMac);

        // Safe fallback: show error instead of crashing or wrong device
        if (deviceIndex == -1) {
          return PageScaffold(
            appBar: AppBar(
              leading: IconButton(
                icon: const Icon(Icons.arrow_back),
                onPressed: () => context.pop(),
              ),
              title: const Text('Thiết bị'),
            ),
            child: Center(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(Icons.device_unknown,
                      size: 64, color: context.colorScheme.onSurfaceVariant),
                  const SizedBox(height: AppSpacing.md),
                  Text(
                    'Không tìm thấy thiết bị',
                    style: context.textTheme.titleMedium?.copyWith(
                      color: context.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
          );
        }

        final device = devices[deviceIndex];

        return PageScaffold(
          appBar: AppBar(
            leading: IconButton(
              icon: const Icon(Icons.arrow_back),
              onPressed: () => context.pop(),
            ),
            title: Text(device.name),
            actions: [
              PopupMenuButton<String>(
                icon: const Icon(Icons.more_vert),
                onSelected: (value) {
                  if (value == 'rename') {
                    _showRenameDialog(context, ref, device);
                  } else if (value == 'delete') {
                    _showDeleteDialog(context, ref, device);
                  }
                },
                itemBuilder: (context) => [
                  const PopupMenuItem(
                    value: 'rename',
                    child: Row(
                      children: [
                        Icon(Icons.edit, size: 20),
                        SizedBox(width: 8),
                        Text('Đổi tên thiết bị'),
                      ],
                    ),
                  ),
                  PopupMenuItem(
                    value: 'delete',
                    child: Row(
                      children: [
                        Icon(Icons.delete,
                            size: 20, color: context.colorScheme.error),
                        const SizedBox(width: 8),
                        Text('Xóa thiết bị',
                            style: TextStyle(color: context.colorScheme.error)),
                      ],
                    ),
                  ),
                ],
              ),
            ],
          ),
          scrollable: false,
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
          child: productUiRegistry.buildDetail(
            context,
            device: device,
            onCapabilityChanged: (capability, value) async {
              await _applyCapabilityChange(
                context,
                ref,
                device,
                capability,
                value,
              );
            },
            onOpenResource: (resource) => _openResource(
              context,
              ref,
              device,
              resource,
            ),
            onReplaceCredential: (credential) => _replaceCredential(
              context,
              ref,
              device,
              credential,
            ),
          ),
        );
      },
    );
  }

  Future<void> _openResource(
    BuildContext context,
    WidgetRef ref,
    DeviceModel device,
    DeviceResourceDefinition resource,
  ) async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      final session =
          await ref.read(devicesProvider.notifier).createResourceSession(
                device.mac,
                resource,
              );
      final status = session['status']?.toString() ?? 'requested';
      if (!context.mounted) return;
      if (status != 'ready') {
        throw StateError(
          session['reason_code']?.toString() ??
              'Thiết bị chưa sẵn sàng cung cấp tài nguyên',
        );
      }
      await showDialog<void>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: const Text('Phiên camera đã sẵn sàng'),
          content: SelectableText(
            session['resource_locator']?.toString() ?? '',
          ),
          actions: [
            FilledButton(
              onPressed: () => Navigator.pop(dialogContext),
              child: const Text('Đóng'),
            ),
          ],
        ),
      );
    } catch (error) {
      messenger.showSnackBar(
        SnackBar(content: Text(AppErrorMapper.mapError(error))),
      );
    }
  }

  Future<void> _replaceCredential(
    BuildContext context,
    WidgetRef ref,
    DeviceModel device,
    DeviceCredentialDefinition credential,
  ) async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      final pin = await _requestNewPin(context, credential);
      if (pin == null) return;
      if (!context.mounted) return;
      final password = await _requestPassword(
        context,
        const CapabilityOperationDescriptor(
          operationName: 'replace_credential',
          confirmation: 'reauthenticate',
          label: 'Đổi mã PIN',
        ),
      );
      if (password == null) return;
      final reauthToken =
          await ref.read(authRepositoryProvider).reauthenticate(password);
      await ref.read(devicesProvider.notifier).replaceCredential(
            device.mac,
            credential,
            pin,
            reauthToken: reauthToken,
          );
      messenger.showSnackBar(
        const SnackBar(
          content: Text(
              'Đã gửi yêu cầu. PIN chỉ có hiệu lực sau khi thiết bị xác nhận.'),
        ),
      );
    } catch (error) {
      messenger.showSnackBar(
        SnackBar(content: Text(AppErrorMapper.mapError(error))),
      );
    }
  }

  Future<String?> _requestNewPin(
    BuildContext context,
    DeviceCredentialDefinition credential,
  ) async {
    final controller = TextEditingController();
    final constraints = credential.definition.constraints;
    final minimum = constraints['min_length'] as int? ?? 4;
    final maximum = constraints['max_length'] as int? ?? 12;
    String? errorText;
    try {
      return await showDialog<String>(
        context: context,
        builder: (dialogContext) => StatefulBuilder(
          builder: (context, setState) => AlertDialog(
            title: const Text('Đặt mã PIN mới'),
            content: TextField(
              controller: controller,
              autofocus: true,
              obscureText: true,
              keyboardType: TextInputType.number,
              maxLength: maximum,
              decoration: InputDecoration(
                labelText: 'PIN $minimum–$maximum chữ số',
                errorText: errorText,
              ),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(dialogContext),
                child: const Text('Hủy'),
              ),
              FilledButton(
                onPressed: () {
                  final value = controller.text.trim();
                  if (!RegExp(r'^\d+$').hasMatch(value) ||
                      value.length < minimum ||
                      value.length > maximum) {
                    setState(() => errorText = 'PIN không đúng định dạng');
                    return;
                  }
                  Navigator.pop(dialogContext, value);
                },
                child: const Text('Tiếp tục'),
              ),
            ],
          ),
        ),
      );
    } finally {
      controller.dispose();
    }
  }

  Future<void> _applyCapabilityChange(
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
        final password = await _requestPassword(context, operation);
        if (password == null) return;
        reauthToken =
            await ref.read(authRepositoryProvider).reauthenticate(password);
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

  Future<String?> _requestPassword(
    BuildContext context,
    CapabilityOperationDescriptor operation,
  ) async {
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
              Text(
                'Thao tác “${operation.label.isEmpty ? operation.operationName : operation.label}” cần nhập lại mật khẩu tài khoản.',
              ),
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

  void _showRenameDialog(
      BuildContext pageContext, WidgetRef ref, DeviceModel device) {
    final controller = TextEditingController(text: device.name);
    showDialog<void>(
      context: pageContext,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Đổi tên thiết bị'),
        content: TextField(
          controller: controller,
          decoration: const InputDecoration(
            hintText: 'Nhập tên mới',
          ),
          autofocus: true,
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: const Text('Hủy'),
          ),
          FilledButton(
            onPressed: () async {
              final newName = controller.text.trim();
              if (newName.isNotEmpty && newName != device.name) {
                Navigator.pop(dialogContext);
                try {
                  await ref
                      .read(devicesProvider.notifier)
                      .renameDevice(device.mac, newName);
                } catch (e) {
                  if (pageContext.mounted) {
                    ScaffoldMessenger.of(pageContext).showSnackBar(
                      SnackBar(content: Text('Lỗi: $e')),
                    );
                  }
                }
              }
            },
            child: const Text('Lưu'),
          ),
        ],
      ),
    ).whenComplete(controller.dispose);
  }

  void _showDeleteDialog(
      BuildContext pageContext, WidgetRef ref, DeviceModel device) {
    final messenger = ScaffoldMessenger.of(pageContext);
    showDialog<void>(
      context: pageContext,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Xóa thiết bị'),
        content: Text(
            'Bạn có chắc chắn muốn xóa "${device.name}"? Hành động này không thể hoàn tác.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: const Text('Hủy'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
                backgroundColor: pageContext.colorScheme.error),
            onPressed: () async {
              Navigator.pop(dialogContext);
              try {
                await ref
                    .read(devicesProvider.notifier)
                    .unpairDevice(device.mac);
                if (pageContext.mounted) {
                  pageContext.pop(); // Go back to dashboard
                  messenger.showSnackBar(
                    const SnackBar(content: Text('Đã xóa thiết bị')),
                  );
                }
              } catch (e) {
                if (pageContext.mounted) {
                  messenger.showSnackBar(
                    SnackBar(content: Text('Lỗi: $e')),
                  );
                }
              }
            },
            child: const Text('Xóa'),
          ),
        ],
      ),
    );
  }
}
