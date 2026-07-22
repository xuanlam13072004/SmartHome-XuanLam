import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';
import '../providers/devices_provider.dart';
import '../widgets/capabilities/capability_registry.dart';
import '../../../domain/models/device_model.dart';

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
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
          child: ListView(
            padding: const EdgeInsets.only(top: AppSpacing.lg, bottom: 100),
            children: [
              // Header: Icon và Trạng thái mạng
              Center(
                child: NeuIconBox(
                  icon: device.icon,
                  size: 100,
                  iconSize: 48,
                  isActive: device.isPrimaryOn,
                  iconColor:
                      device.isPrimaryOn ? context.colorScheme.primary : null,
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(height: AppSpacing.md),
              Center(
                child: StatusBadge(status: device.status),
              ),
              const SizedBox(height: AppSpacing.xxl),

              // Render danh sách Capabilities tự động
              ...capabilityRegistry.buildWidgets(
                context,
                device.capabilities,
                (capId, value) {
                  ref.read(devicesProvider.notifier).updateCapability(
                        deviceMac,
                        capId,
                        value,
                      );
                },
              ),
            ],
          ),
        );
      },
    );
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
