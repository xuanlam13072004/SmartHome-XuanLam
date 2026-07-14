import 'package:flutter/material.dart';
import 'package:lucide_icons/lucide_icons.dart';
import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';
import '../models/device_mock.dart';

class DashboardScreen extends StatelessWidget {
  const DashboardScreen({super.key});

  @override
  Widget build(BuildContext context) {
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
          SliverPadding(
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
                  final device = DeviceMock.staticDevices[index];
                  return DeviceCard(
                    title: device.title,
                    subtitle: device.subtitle,
                    icon: device.icon,
                    status: device.status,
                    iconColor: device.isOn ? context.colorScheme.primary : null,
                    // Tạm thời hiển thị Toggle cho mọi thiết bị online
                    actionWidget: device.status == DeviceStatus.online
                        ? NeuToggle(
                            value: device.isOn,
                            onChanged: (_) {},
                            width: 44,
                            height: 24,
                          )
                        : null,
                  );
                },
                childCount: DeviceMock.staticDevices.length,
              ),
            ),
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
