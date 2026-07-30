// Hallmark · pre-emit critique: P5 H5 E4 S5 R4 V5
// Hallmark · modern-minimal · calm precision · device hero → controls → sensors → diagnostics
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';
import '../providers/devices_provider.dart';
import '../models/capability_model.dart';
import '../widgets/capabilities/capability_section_panel.dart';
import '../widgets/device_hero_card.dart';
import '../../../domain/models/device_model.dart';
import '../widgets/device_topology_panel.dart';

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
        final primaryPower = _primaryPower(device.capabilities);
        final controls = device.capabilities
            .where((capability) =>
                capability.section == CapabilitySection.control &&
                capability != primaryPower)
            .toList();
        final sensors = device.capabilities
            .where(
                (capability) => capability.section == CapabilitySection.sensor)
            .toList();
        final diagnostics = device.capabilities
            .where((capability) =>
                capability.section == CapabilitySection.diagnostic)
            .toList();

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
          child: ListView(
            padding: const EdgeInsets.only(
              top: AppSpacing.md,
              bottom: 100,
            ),
            children: [
              DeviceHeroCard(
                device: device,
                primaryPower: primaryPower,
                onPowerChanged: primaryPower == null
                    ? null
                    : (value) =>
                        ref.read(devicesProvider.notifier).updateCapability(
                              deviceMac,
                              primaryPower.id,
                              value,
                            ),
              ),
              if (device.topology != null) ...[
                const SizedBox(height: AppSpacing.xl),
                DeviceTopologyPanel(topology: device.topology!),
              ],
              if (controls.isNotEmpty) ...[
                const SizedBox(height: AppSpacing.xl),
                CapabilitySectionPanel(
                  title: 'Điều khiển',
                  description: 'Các chức năng có thể thay đổi trực tiếp',
                  icon: Icons.tune_rounded,
                  capabilities: controls,
                  onCapabilityChanged: (capId, value) {
                    ref.read(devicesProvider.notifier).updateCapability(
                          deviceMac,
                          capId,
                          value,
                        );
                  },
                ),
              ],
              if (sensors.isNotEmpty) ...[
                const SizedBox(height: AppSpacing.xl),
                CapabilitySectionPanel(
                  title: 'Cảm biến',
                  description: 'Trạng thái mới nhất từ thiết bị',
                  icon: Icons.sensors_rounded,
                  capabilities: sensors,
                  useGrid: true,
                  onCapabilityChanged: (capId, value) {
                    ref.read(devicesProvider.notifier).updateCapability(
                          deviceMac,
                          capId,
                          value,
                        );
                  },
                ),
              ],
              if (diagnostics.isNotEmpty) ...[
                const SizedBox(height: AppSpacing.xl),
                CapabilitySectionPanel(
                  title: 'Chẩn đoán',
                  description: 'Thông tin kỹ thuật và chất lượng kết nối',
                  icon: Icons.monitor_heart_rounded,
                  capabilities: diagnostics,
                  useGrid: true,
                  collapsible: true,
                  initiallyExpanded: false,
                  onCapabilityChanged: (capId, value) {
                    ref.read(devicesProvider.notifier).updateCapability(
                          deviceMac,
                          capId,
                          value,
                        );
                  },
                ),
              ],
              if (device.capabilities.isEmpty) ...[
                const SizedBox(height: AppSpacing.xl),
                const EmptyState(
                  icon: Icons.widgets_outlined,
                  title: 'Chưa có chức năng',
                  description:
                      'Thiết bị chưa công bố capability trong Product Catalog.',
                ),
              ],
              const SizedBox(height: AppSpacing.xl),
            ],
          ),
        );
      },
    );
  }

  CapabilityModel? _primaryPower(List<CapabilityModel> capabilities) {
    CapabilityModel? fallback;
    for (final capability in capabilities) {
      if (capability.section != CapabilitySection.control ||
          capability.type != 'on_off') {
        continue;
      }
      fallback ??= capability;
      final hint = '${capability.semanticRole} ${capability.id}'.toLowerCase();
      if (hint.contains('power') ||
          hint.contains('switch') ||
          hint.contains('light')) {
        return capability;
      }
    }
    return fallback;
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
