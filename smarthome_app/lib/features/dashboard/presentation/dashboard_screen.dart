import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons/lucide_icons.dart';
import '../../../core/core.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/widgets/widgets.dart';
import '../providers/devices_provider.dart';
import '../providers/realtime_provider.dart';
import '../../../core/network/websocket_client.dart';

class DashboardScreen extends ConsumerWidget {
  const DashboardScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final devicesAsync = ref.watch(devicesProvider);
    // Initialize WebSocket lifecycle (connects when authenticated)
    ref.watch(webSocketLifecycleProvider);
    
    // Scaffold được bọc sẵn để tương thích AppShell
    return Scaffold(
      backgroundColor: context.colorScheme.surface,
      body: CustomScrollView(
        slivers: [
          // ── Sliver AppBar ────────────────────────────────────────────────
          SliverAppBar(
            expandedHeight: 120.0,
            floating: true,
            pinned: true,
            backgroundColor: context.colorScheme.surface,
            elevation: 0,
            flexibleSpace: FlexibleSpaceBar(
              titlePadding: const EdgeInsets.symmetric(
                horizontal: AppSpacing.md,
                vertical: AppSpacing.sm,
              ),
              title: Text(
                'Nhà của Lâm',
                style: context.textTheme.headlineSmall?.copyWith(
                  fontWeight: FontWeight.bold,
                  color: context.colorScheme.onSurface,
                ),
              ),
              background: Container(
                padding: const EdgeInsets.only(
                  left: AppSpacing.md,
                  right: AppSpacing.md,
                  top: AppSpacing.xxl + AppSpacing.md, // SafeArea bù trừ
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Chào buổi sáng,',
                          style: context.textTheme.bodyLarge?.copyWith(
                            color: context.colorScheme.onSurfaceVariant,
                          ),
                        ),
                      ],
                    ),
                    NeuIconBox(
                      icon: LucideIcons.cloudSun,
                      isActive: true,
                      iconColor: context.neu.categoryLight,
                      shape: BoxShape.circle,
                    ),
                    const _ConnectionStatusIndicator(),
                  ],
                ),
              ),
            ),
          ),

          // ── Môi trường & An ninh (Environment Summary) ───────────────────
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
              child: Row(
                children: [
                  Expanded(
                    child: NeuCard(
                      padding: const EdgeInsets.all(AppSpacing.md),
                      child: Row(
                        children: [
                          const Icon(LucideIcons.thermometer, size: 28),
                          const SizedBox(width: AppSpacing.sm),
                          Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'Trong nhà',
                                style: context.textTheme.labelMedium?.copyWith(
                                  color: context.colorScheme.onSurfaceVariant,
                                ),
                              ),
                              Text(
                                '26°C - 55%',
                                style: context.textTheme.titleMedium?.copyWith(
                                  fontWeight: FontWeight.bold,
                                ),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(width: AppSpacing.md),
                  Expanded(
                    child: NeuCard(
                      padding: const EdgeInsets.all(AppSpacing.md),
                      child: Row(
                        children: [
                          Icon(LucideIcons.shieldCheck,
                              size: 28, color: context.colorScheme.primary),
                          const SizedBox(width: AppSpacing.sm),
                          Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'An ninh',
                                style: context.textTheme.labelMedium?.copyWith(
                                  color: context.colorScheme.onSurfaceVariant,
                                ),
                              ),
                              Text(
                                'An toàn',
                                style: context.textTheme.titleMedium?.copyWith(
                                  fontWeight: FontWeight.bold,
                                  color: context.colorScheme.primary,
                                ),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),

          // ── Quick Filters (Phân loại phòng) ──────────────────────────────
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.only(
                top: AppSpacing.lg,
                bottom: AppSpacing.md,
              ),
              child: SizedBox(
                height: 40,
                child: ListView(
                  scrollDirection: Axis.horizontal,
                  padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
                  children: [
                    NeuChip(label: 'Tất cả', isSelected: true, onSelected: (_) {}),
                    const SizedBox(width: AppSpacing.sm),
                    NeuChip(label: 'Phòng khách', isSelected: false, onSelected: (_) {}),
                    const SizedBox(width: AppSpacing.sm),
                    NeuChip(label: 'Phòng ngủ', isSelected: false, onSelected: (_) {}),
                    const SizedBox(width: AppSpacing.sm),
                    NeuChip(label: 'Nhà bếp', isSelected: false, onSelected: (_) {}),
                  ],
                ),
              ),
            ),
          ),

          // ── Device Grid (Responsive) ─────────────────────────────────────
          devicesAsync.when(
            loading: () => const SliverToBoxAdapter(
              child: Center(child: CircularProgressIndicator()),
            ),
            error: (err, stack) => SliverToBoxAdapter(
              child: Center(child: Text('Lỗi tải thiết bị: $err')),
            ),
            data: (devices) {
              return SliverPadding(
                padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
                sliver: SliverGrid(
                  // Responsive: 2 cột trên điện thoại, tự giãn ra nếu màn hình lớn
                  gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                    maxCrossAxisExtent: 220, // Độ rộng tối đa mỗi thẻ
                    mainAxisSpacing: AppSpacing.md,
                    crossAxisSpacing: AppSpacing.md,
                    childAspectRatio: 0.9, // Tỉ lệ chiều rộng / chiều cao của thẻ
                  ),
                  delegate: SliverChildBuilderDelegate(
                    (context, index) {
                      final device = devices[index];
                      
                      // Lấy primary capability (on_off) nếu có
                      Widget? actionWidget;
                      final onOffCap = device.capabilities.where((c) => c.type == 'on_off').firstOrNull;
                      
                      if (onOffCap != null && device.status == DeviceStatus.online) {
                        actionWidget = NeuToggle(
                          value: onOffCap.value as bool? ?? false,
                          onChanged: (val) {
                            ref.read(devicesProvider.notifier).updateCapability(device.id, onOffCap.id, val);
                          },
                          width: 44,
                          height: 24,
                        );
                      }

                      return DeviceCard(
                        title: device.name,
                        subtitle: device.room,
                        icon: device.icon,
                        status: device.status,
                        iconColor: device.isPrimaryOn ? context.colorScheme.primary : null,
                        actionWidget: actionWidget,
                        onTap: () {
                          context.push('/device/${device.id}');
                        },
                      );
                    },
                    childCount: devices.length,
                  ),
                ),
              );
            },
          ),

          // Padding dưới cùng cho ScrollView để không bị lẹm vào BottomBar
          const SliverToBoxAdapter(
            child: SizedBox(height: 100), // Khoảng trống an toàn
          ),
        ],
      ),
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
                style: TextStyle(color: color, fontSize: 10, fontWeight: FontWeight.bold),
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
