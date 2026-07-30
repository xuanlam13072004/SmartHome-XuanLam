import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons/lucide_icons.dart';
import '../../../core/core.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/widgets/widgets.dart';
import '../providers/devices_provider.dart';
import '../providers/realtime_provider.dart';
import '../../../core/network/websocket_client.dart';
import 'qr_scanner_screen.dart';

class DashboardScreen extends ConsumerWidget {
  const DashboardScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final devicesAsync = ref.watch(devicesProvider);
    // Initialize WebSocket lifecycle (connects when authenticated)
    ref.watch(webSocketLifecycleProvider);

    return Scaffold(
      backgroundColor: context.colorScheme.surface,
      body: Container(
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [
              const Color(0xFFF0F4FF), // Soft blue tint
              context.colorScheme.surface,
              const Color(0xFFFFF0F5), // Soft pink/purple tint
            ],
            stops: const [0.0, 0.5, 1.0],
          ),
        ),
        child: CustomScrollView(
          slivers: [
            // ── Sliver AppBar ────────────────────────────────────────────────
            SliverAppBar(
              expandedHeight: 120.0,
              floating: true,
              pinned: true,
              backgroundColor: Colors.transparent,
              elevation: 0,
              flexibleSpace: FlexibleSpaceBar(
                titlePadding: const EdgeInsets.symmetric(
                  horizontal: AppSpacing.md,
                  vertical: AppSpacing.smMd,
                ),
                title: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      _greeting(),
                      style: context.textTheme.labelMedium?.copyWith(
                        color: context.colorScheme.onSurfaceVariant,
                        fontWeight: FontWeight.w400,
                      ),
                    ),
                    Text(
                      'SmartHome',
                      style: context.textTheme.headlineSmall?.copyWith(
                        fontWeight: FontWeight.bold,
                        color: context.colorScheme.onSurface,
                      ),
                    ),
                  ],
                ),
                background: Container(
                  padding: const EdgeInsets.only(
                    left: AppSpacing.md,
                    right: AppSpacing.md,
                    top: AppSpacing.xxl + AppSpacing.md,
                  ),
                  child: const Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: [
                      _ConnectionStatusIndicator(),
                    ],
                  ),
                ),
              ),
            ),

            // ── Device Summary ──────────────────────────────────────────────
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
                child: devicesAsync.when(
                  loading: () => const SizedBox.shrink(),
                  error: (_, __) => const SizedBox.shrink(),
                  data: (devices) {
                    final onlineCount = devices
                        .where((d) => d.status == DeviceStatus.online)
                        .length;
                    final totalCount = devices.length;
                    final assignedNetworks = devices
                        .map((device) => device.topology?.networkId)
                        .whereType<String>()
                        .toSet()
                        .length;
                    final hubCount = devices
                        .where((device) => device.topology?.isHub == true)
                        .length;
                    return NeuCard(
                      padding: const EdgeInsets.all(AppSpacing.md),
                      child: Wrap(
                        spacing: AppSpacing.lg,
                        runSpacing: AppSpacing.sm,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          _DashboardMetric(
                            icon: LucideIcons.cpu,
                            label: 'Thiết bị',
                            value: '$onlineCount/$totalCount online',
                          ),
                          if (assignedNetworks > 0)
                            _DashboardMetric(
                              icon: Icons.lan_rounded,
                              label: 'Mạng',
                              value: '$assignedNetworks mạng · $hubCount Hub',
                            ),
                        ],
                      ),
                    );
                  },
                ),
              ),
            ),

            const SliverToBoxAdapter(
              child: SizedBox(height: AppSpacing.lg),
            ),

            // ── Device Grid (Responsive) ─────────────────────────────────────
            devicesAsync.when(
              loading: () => const SliverToBoxAdapter(
                child: Center(child: CircularProgressIndicator()),
              ),
              error: (err, stack) => SliverToBoxAdapter(
                child: Center(
                  child: Padding(
                    padding: const EdgeInsets.all(AppSpacing.xl),
                    child: Column(
                      children: [
                        Icon(LucideIcons.alertTriangle,
                            size: 48, color: context.colorScheme.error),
                        const SizedBox(height: AppSpacing.md),
                        Text(
                          'Không thể tải danh sách thiết bị',
                          style: context.textTheme.bodyLarge?.copyWith(
                            color: context.colorScheme.error,
                          ),
                        ),
                        const SizedBox(height: AppSpacing.sm),
                        Text(
                          'Kiểm tra kết nối mạng và thử lại',
                          style: context.textTheme.bodySmall?.copyWith(
                            color: context.colorScheme.onSurfaceVariant,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
              data: (devices) {
                // Empty state
                if (devices.isEmpty) {
                  return SliverToBoxAdapter(
                    child: Padding(
                      padding: const EdgeInsets.all(AppSpacing.xxl),
                      child: Center(
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Icon(
                              LucideIcons.plus,
                              size: 64,
                              color: context.colorScheme.onSurfaceVariant
                                  .withValues(alpha: 0.4),
                            ),
                            const SizedBox(height: AppSpacing.md),
                            Text(
                              'Chưa có thiết bị nào',
                              style: context.textTheme.titleMedium?.copyWith(
                                color: context.colorScheme.onSurfaceVariant,
                              ),
                            ),
                            const SizedBox(height: AppSpacing.xs),
                            Text(
                              'Kết nối thiết bị đầu tiên của bạn',
                              style: context.textTheme.bodySmall?.copyWith(
                                color: context.colorScheme.onSurfaceVariant
                                    .withValues(alpha: 0.7),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  );
                }

                return SliverPadding(
                  padding:
                      const EdgeInsets.symmetric(horizontal: AppSpacing.md),
                  sliver: SliverGrid(
                    gridDelegate:
                        const SliverGridDelegateWithMaxCrossAxisExtent(
                      maxCrossAxisExtent: 220,
                      mainAxisSpacing: AppSpacing.md,
                      crossAxisSpacing: AppSpacing.md,
                      childAspectRatio: 0.9,
                    ),
                    delegate: SliverChildBuilderDelegate(
                      (context, index) {
                        final device = devices[index];

                        // Lấy primary capability (on_off) nếu có
                        Widget? actionWidget;
                        final onOffCap = device.capabilities
                            .where((c) => c.type == 'on_off')
                            .firstOrNull;

                        if (onOffCap != null &&
                            device.status == DeviceStatus.online) {
                          actionWidget = NeuToggle(
                            value: onOffCap.value as bool? ?? false,
                            onChanged: (val) {
                              ref
                                  .read(devicesProvider.notifier)
                                  .updateCapability(
                                    device.mac,
                                    onOffCap.id,
                                    val,
                                  );
                            },
                            width: 44,
                            height: 24,
                          );
                        }

                        // Hallmark: Solid color theo category
                        final glowColor = AppPalette.colorForCategory(
                          device.productId.contains('light')
                              ? 'light'
                              : device.productId.contains('security')
                                  ? 'security'
                                  : device.productId.contains('roof')
                                      ? 'environment'
                                      : 'sensor',
                        );

                        return DeviceCard(
                          title: device.name,
                          icon: device.icon,
                          status: device.status,
                          iconColor: device.isPrimaryOn
                              ? context.colorScheme.primary
                              : null,
                          actionWidget: actionWidget,
                          capabilities: device.capabilities,
                          isPrimaryOn: device.isPrimaryOn,
                          glowColor: glowColor,
                          connectionIcon: device.topology == null
                              ? null
                              : device.topology!.isHub
                                  ? Icons.hub_rounded
                                  : device.topology!.usesDirectFallback
                                      ? Icons.cloud_done_rounded
                                      : Icons.device_hub_rounded,
                          connectionLabel: device.topology?.connectionLabel,
                          connectionColor: device.topology == null
                              ? null
                              : device.topology!.isOptimizing ||
                                      device.topology!.usesDirectFallback
                                  ? context.colorScheme.secondary
                                  : device.topology!.isHub
                                      ? context.colorScheme.primary
                                      : context.neu.deviceOnline,
                          onTap: () {
                            context.push('/device/${device.mac}');
                          },
                        );
                      },
                      childCount: devices.length,
                    ),
                  ),
                );
              },
            ),

            const SliverToBoxAdapter(
              child: SizedBox(height: 100),
            ),
          ],
        ),
      ),
      floatingActionButton: Padding(
        padding: const EdgeInsets.only(bottom: 80.0), // Tránh đè lên Bottom Nav
        child: FloatingActionButton(
          onPressed: () async {
            // Đẩy sang màn hình quét QR
            final claimed =
                await Navigator.of(context, rootNavigator: true).push<bool>(
              MaterialPageRoute<bool>(
                  builder: (context) => const QRScannerScreen()),
            );
            if (claimed == true && context.mounted) {
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('Đã thêm thiết bị thành công')),
              );
            }
          },
          backgroundColor: context.colorScheme.primary,
          child: Icon(LucideIcons.plus, color: context.colorScheme.onPrimary),
        ),
      ),
    );
  }

  /// Hallmark: Lời chào theo thời gian trong ngày.
  static String _greeting() {
    final hour = DateTime.now().hour;
    if (hour < 6) return 'Khuya rồi 🌙';
    if (hour < 12) return 'Chào buổi sáng ☀️';
    if (hour < 18) return 'Chào buổi chiều 🌤️';
    return 'Chào buổi tối 🌆';
  }
}

class _DashboardMetric extends StatelessWidget {
  const _DashboardMetric({
    required this.icon,
    required this.label,
    required this.value,
  });

  final IconData icon;
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 26, color: context.colorScheme.primary),
        const SizedBox(width: AppSpacing.sm),
        Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              label,
              style: context.textTheme.labelMedium?.copyWith(
                color: context.colorScheme.onSurfaceVariant,
              ),
            ),
            Text(
              value,
              style: context.textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.bold,
              ),
            ),
          ],
        ),
      ],
    );
  }
}

class _ConnectionStatusIndicator extends ConsumerWidget {
  const _ConnectionStatusIndicator();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final statusAsync = ref.watch(connectionStatusProvider);

    return statusAsync.when(
      data: (status) {
        Color color;
        IconData icon;
        switch (status) {
          case ConnectionStatus.connected:
            color = Colors.green;
            icon = LucideIcons.wifi;
            break;
          case ConnectionStatus.connecting:
          case ConnectionStatus.authenticating:
          case ConnectionStatus.reconnecting:
            color = Colors.orange;
            icon = LucideIcons.loader;
            break;
          case ConnectionStatus.disconnected:
          case ConnectionStatus.error:
            color = Colors.red;
            icon = LucideIcons.wifiOff;
            break;
        }

        return Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
          decoration: BoxDecoration(
            color: color.withValues(alpha: 0.1),
            borderRadius: BorderRadius.circular(12),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 12, color: color),
              const SizedBox(width: 4),
              Text(
                status.name,
                style: TextStyle(
                    color: color, fontSize: 10, fontWeight: FontWeight.bold),
              ),
            ],
          ),
        );
      },
      loading: () => const SizedBox.shrink(),
      error: (_, __) => const SizedBox.shrink(),
    );
  }
}
