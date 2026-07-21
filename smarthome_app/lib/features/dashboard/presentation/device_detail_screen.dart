import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';
import '../providers/devices_provider.dart';
import '../widgets/capabilities/capability_registry.dart';

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
                  Icon(Icons.device_unknown, size: 64, color: context.colorScheme.onSurfaceVariant),
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
              IconButton(
                icon: const Icon(Icons.settings_outlined),
                onPressed: () {},
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
                  iconColor: device.isPrimaryOn ? context.colorScheme.primary : null,
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
                  // Find the capability to get its real action and instance
                  final cap = device.capabilities.firstWhere(
                    (c) => c.id == capId,
                    orElse: () => device.capabilities.first,
                  );
                  ref.read(devicesProvider.notifier).updateCapability(
                    deviceMac,
                    capId,
                    cap.instance,
                    cap.action ?? capId,
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
}
