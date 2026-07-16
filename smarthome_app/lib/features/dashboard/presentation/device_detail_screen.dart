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
    required this.deviceId,
  });

  final String deviceId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final devicesAsync = ref.watch(devicesProvider);

    return devicesAsync.when(
      loading: () => const PageScaffold(
        appBar: null,
        child: Center(child: CircularProgressIndicator()),
      ),
      error: (err, stack) => PageScaffold(
        appBar: null,
        child: Center(child: Text('Lỗi: $err')),
      ),
      data: (devices) {
        final device = devices.firstWhere(
          (d) => d.id == deviceId,
          orElse: () => devices.first, // fallback
        );

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
                  ref.read(devicesProvider.notifier).updateCapability(deviceId, capId, value);
                },
              ),
            ],
          ),
        );
      },
    );
  }
}

