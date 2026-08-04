// Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V5
// Hallmark · workbench · status first → task controls → evidence → diagnostics
import 'package:flutter/material.dart';

import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';
import '../../../domain/models/device_model.dart';
import '../../dashboard/models/capability_model.dart';
import '../../dashboard/widgets/capabilities/capability_section_panel.dart';
import '../../dashboard/widgets/device_hero_card.dart';
import '../../dashboard/widgets/device_topology_panel.dart';
import '../product_capability_query.dart';
import 'product_mini_cards.dart';

class GenericProductDetail extends StatelessWidget {
  const GenericProductDetail({
    super.key,
    required this.device,
    required this.onCapabilityChanged,
  });

  final DeviceModel device;
  final ProductCapabilityChanged onCapabilityChanged;

  @override
  Widget build(BuildContext context) {
    final primary = device.primaryOnOff;
    final used = <CapabilityModel>{if (primary != null) primary};
    return ProductDetailWorkbench(
      device: device,
      heroIcon: device.icon,
      primaryPower: primary,
      onCapabilityChanged: onCapabilityChanged,
      summaries: [
        ProductStatusFact(
          icon: Icons.wifi_rounded,
          label: 'Kết nối',
          value: device.status == DeviceStatus.online ? 'Online' : 'Offline',
        ),
        ProductStatusFact(
          icon: Icons.widgets_rounded,
          label: 'Chức năng',
          value: '${device.capabilities.length}',
        ),
      ],
      groups: _remainingGroups(device, used),
    );
  }
}

class EntranceProductDetail extends StatelessWidget {
  const EntranceProductDetail({
    super.key,
    required this.device,
    required this.onCapabilityChanged,
  });

  final DeviceModel device;
  final ProductCapabilityChanged onCapabilityChanged;

  @override
  Widget build(BuildContext context) {
    final used = <CapabilityModel>{};
    final lock = device.capabilityMatching(
      ids: const ['lock_state', 'target_lock_state'],
      capabilityIds: const ['door_lock'],
    );
    final camera = device.capabilityMatching(
      ids: const ['is_streaming', 'camera_state'],
      capabilityIds: const ['camera_stream'],
    );
    final access = _take(
      device,
      used,
      hints: const [
        'lock',
        'access',
        'pin',
        'password',
        'credential',
        'fingerprint',
        'recognition',
        'servo',
      ],
      section: CapabilitySection.control,
    );
    final interface = _take(
      device,
      used,
      hints: const [
        'camera',
        'stream',
        'snapshot',
        'lcd',
        'display',
        'keypad',
      ],
    );
    return ProductDetailWorkbench(
      device: device,
      heroIcon: Icons.door_front_door_rounded,
      onCapabilityChanged: onCapabilityChanged,
      summaries: [
        ProductStatusFact(
          icon: Icons.lock_rounded,
          label: 'Khóa cửa',
          value: _lockLabel(lock),
          tone: _isLocked(lock)
              ? context.colorScheme.primary
              : context.colorScheme.error,
        ),
        ProductStatusFact(
          icon: Icons.videocam_rounded,
          label: 'Camera',
          value: _truthy(camera?.value) ? 'Đang truyền' : 'Sẵn sàng',
        ),
        const ProductStatusFact(
          icon: Icons.verified_user_rounded,
          label: 'Kiểm soát',
          value: 'Tại thiết bị',
        ),
      ],
      groups: [
        ProductCapabilityGroup(
          title: 'Ra vào & bảo mật',
          description: 'Khóa cửa và các cấu hình xác thực được thiết bị hỗ trợ',
          icon: Icons.admin_panel_settings_rounded,
          capabilities: access,
        ),
        ProductCapabilityGroup(
          title: 'Camera, LCD & bàn phím',
          description: 'Tương tác trực tiếp với phần cứng tại cửa chính',
          icon: Icons.space_dashboard_rounded,
          capabilities: interface,
        ),
        ..._remainingGroups(device, used),
      ],
    );
  }
}

class RoofProductDetail extends StatelessWidget {
  const RoofProductDetail({
    super.key,
    required this.device,
    required this.onCapabilityChanged,
  });

  final DeviceModel device;
  final ProductCapabilityChanged onCapabilityChanged;

  @override
  Widget build(BuildContext context) {
    final used = <CapabilityModel>{};
    final position = device.capabilityMatching(
      ids: const ['current_position', 'target_position'],
      capabilityIds: const ['cover_controller'],
    );
    final rain = device.capabilityMatching(
      ids: const ['rain_detected', 'rain_state'],
      capabilityIds: const ['rain_sensor'],
    );
    final movement = device.capabilityMatching(
      ids: const ['movement_status'],
      capabilityIds: const ['cover_controller'],
    );
    final motionControls = _take(
      device,
      used,
      hints: const ['cover', 'roof', 'position', 'movement', 'awning', 'motor'],
      section: CapabilitySection.control,
    );
    final automation = _take(
      device,
      used,
      hints: const ['auto', 'rain', 'protect', 'mode'],
      section: CapabilitySection.control,
    );
    final environment = _take(
      device,
      used,
      hints: const ['rain', 'light', 'temperature', 'humidity'],
    );
    final raining =
        _truthy(rain?.value) || '${rain?.value}'.toLowerCase().contains('rain');
    return ProductDetailWorkbench(
      device: device,
      heroIcon: Icons.roofing_rounded,
      onCapabilityChanged: onCapabilityChanged,
      summaries: [
        ProductStatusFact(
          icon: Icons.open_in_full_rounded,
          label: 'Độ mở',
          value: productCapabilityValue(position, fallback: '—'),
        ),
        ProductStatusFact(
          icon: raining ? Icons.water_drop_rounded : Icons.cloud_outlined,
          label: 'Cảm biến mưa',
          value: raining ? 'Đang mưa' : 'Khô ráo',
          tone: raining ? context.colorScheme.secondary : null,
        ),
        ProductStatusFact(
          icon: Icons.swap_vert_rounded,
          label: 'Chuyển động',
          value: productCapabilityValue(movement, fallback: 'Đã dừng'),
        ),
      ],
      groups: [
        ProductCapabilityGroup(
          title: 'Điều khiển mái che',
          description: 'Mở, đóng, dừng hoặc chọn vị trí mái che',
          icon: Icons.open_in_full_rounded,
          capabilities: motionControls,
        ),
        ProductCapabilityGroup(
          title: 'Bảo vệ khi mưa',
          description: 'Bật hoặc tắt cơ chế tự đóng mái che khi phát hiện mưa',
          icon: Icons.umbrella_rounded,
          capabilities: automation,
        ),
        ProductCapabilityGroup(
          title: 'Điều kiện môi trường',
          description: 'Dữ liệu thiết bị dùng cho quyết định tự động tại chỗ',
          icon: Icons.sensors_rounded,
          capabilities: environment,
          useGrid: true,
        ),
        ..._remainingGroups(device, used),
      ],
    );
  }
}

class HazardProductDetail extends StatelessWidget {
  const HazardProductDetail({
    super.key,
    required this.device,
    required this.onCapabilityChanged,
  });

  final DeviceModel device;
  final ProductCapabilityChanged onCapabilityChanged;

  @override
  Widget build(BuildContext context) {
    final used = <CapabilityModel>{};
    final flame = device.capabilityMatching(ids: const ['flame_detected']);
    final gas = device.capabilityMatching(
      ids: const ['gas_level', 'mq2_level', 'smoke_level'],
    );
    final siren = device.capabilityMatching(
      ids: const ['siren_active', 'audible_state'],
    );
    final environment = _take(
      device,
      used,
      hints: const [
        'flame',
        'gas',
        'mq2',
        'smoke',
        'temperature',
        'humidity',
      ],
      section: CapabilitySection.sensor,
    );
    final alarmControls = _take(
      device,
      used,
      hints: const ['siren', 'alarm', 'mute', 'silence', 'buzzer', 'fan'],
      section: CapabilitySection.control,
    );
    final alert = _truthy(flame?.value) || _truthy(siren?.value);
    return ProductDetailWorkbench(
      device: device,
      heroIcon: alert ? Icons.warning_rounded : Icons.health_and_safety_rounded,
      heroAccent: alert ? context.colorScheme.error : context.neu.deviceOnline,
      summaryBeforeHero: true,
      onCapabilityChanged: onCapabilityChanged,
      summaries: [
        ProductStatusFact(
          icon: alert ? Icons.warning_rounded : Icons.shield_rounded,
          label: 'Trạng thái an toàn',
          value: alert ? 'Cần kiểm tra' : 'An toàn',
          tone: alert ? context.colorScheme.error : context.neu.deviceOnline,
        ),
        ProductStatusFact(
          icon: Icons.local_fire_department_rounded,
          label: 'Ngọn lửa',
          value: _truthy(flame?.value) ? 'Phát hiện' : 'Bình thường',
        ),
        ProductStatusFact(
          icon: Icons.air_rounded,
          label: 'Khí/khói',
          value: productCapabilityValue(gas, fallback: 'Ổn định'),
        ),
      ],
      groups: [
        ProductCapabilityGroup(
          title: 'Chỉ số an toàn',
          description: 'Dữ liệu mới nhất từ flame sensor, MQ2 và DHT11',
          icon: Icons.monitor_heart_rounded,
          capabilities: environment,
          useGrid: true,
        ),
        ProductCapabilityGroup(
          title: 'Cảnh báo tại chỗ',
          description:
              'Điều khiển còi và khoảng tạm dừng cảnh báo nếu được hỗ trợ',
          icon: Icons.notifications_active_rounded,
          capabilities: alarmControls,
        ),
        ..._remainingGroups(device, used),
      ],
    );
  }
}

class IrrigationProductDetail extends StatelessWidget {
  const IrrigationProductDetail({
    super.key,
    required this.device,
    required this.onCapabilityChanged,
  });

  final DeviceModel device;
  final ProductCapabilityChanged onCapabilityChanged;

  @override
  Widget build(BuildContext context) {
    final used = <CapabilityModel>{};
    final moisture = device.capabilityMatching(
      ids: const ['soil_moisture', 'moisture_level'],
    );
    final water = device.capabilityMatching(
      ids: const ['water_level', 'water_availability'],
    );
    final pump = device.capabilityMatching(
      ids: const ['pump_active', 'pump_state', 'pump_output_state'],
    );
    final waterControls = _take(
      device,
      used,
      hints: const ['pump', 'valve', 'water_output'],
      section: CapabilitySection.control,
    );
    final automation = _take(
      device,
      used,
      hints: const ['auto', 'schedule', 'threshold', 'irrigation', 'mode'],
      section: CapabilitySection.control,
    );
    final sensors = _take(
      device,
      used,
      hints: const ['moisture', 'water', 'flow', 'rain'],
      section: CapabilitySection.sensor,
    );
    final pumping =
        _truthy(pump?.value) || '${pump?.value}'.toLowerCase().contains('on');
    return ProductDetailWorkbench(
      device: device,
      heroIcon: pumping ? Icons.water_rounded : Icons.grass_rounded,
      onCapabilityChanged: onCapabilityChanged,
      summaries: [
        ProductStatusFact(
          icon: Icons.eco_rounded,
          label: 'Độ ẩm đất',
          value: productCapabilityValue(moisture, fallback: '—'),
        ),
        ProductStatusFact(
          icon: Icons.water_drop_outlined,
          label: 'Nguồn nước',
          value: productCapabilityValue(water, fallback: '—'),
        ),
        ProductStatusFact(
          icon: Icons.water_rounded,
          label: 'Máy bơm',
          value: pumping ? 'Đang tưới' : 'Đang nghỉ',
        ),
      ],
      groups: [
        ProductCapabilityGroup(
          title: 'Bơm & van nước',
          description: 'Điều khiển đường nước khi cần tưới thủ công',
          icon: Icons.water_drop_rounded,
          capabilities: waterControls,
        ),
        ProductCapabilityGroup(
          title: 'Tưới tự động',
          description: 'Chế độ và ngưỡng mà bộ điều khiển dùng tại chỗ',
          icon: Icons.auto_mode_rounded,
          capabilities: automation,
        ),
        ProductCapabilityGroup(
          title: 'Đất & nguồn nước',
          description: 'Căn cứ để thiết bị quyết định thời điểm tưới',
          icon: Icons.sensors_rounded,
          capabilities: sensors,
          useGrid: true,
        ),
        ..._remainingGroups(device, used),
      ],
    );
  }
}

class ProductDetailWorkbench extends StatelessWidget {
  const ProductDetailWorkbench({
    super.key,
    required this.device,
    required this.heroIcon,
    required this.summaries,
    required this.groups,
    required this.onCapabilityChanged,
    this.heroAccent,
    this.primaryPower,
    this.summaryBeforeHero = false,
  });

  final DeviceModel device;
  final IconData heroIcon;
  final Color? heroAccent;
  final CapabilityModel? primaryPower;
  final List<ProductStatusFact> summaries;
  final List<ProductCapabilityGroup> groups;
  final ProductCapabilityChanged onCapabilityChanged;
  final bool summaryBeforeHero;

  @override
  Widget build(BuildContext context) {
    final visibleGroups =
        groups.where((group) => group.capabilities.isNotEmpty);
    final hero = DeviceHeroCard(
      device: device,
      identityIcon: heroIcon,
      identityAccent: heroAccent,
      primaryPower: primaryPower,
      onPowerChanged: primaryPower == null
          ? null
          : (value) => onCapabilityChanged(primaryPower!.id, value),
    );
    final summary = ProductStatusPanel(facts: summaries);

    return ListView(
      padding: const EdgeInsets.only(top: AppSpacing.md, bottom: 100),
      children: [
        if (summaryBeforeHero) ...[
          summary,
          const SizedBox(height: AppSpacing.xl),
        ],
        hero,
        if (!summaryBeforeHero) ...[
          const SizedBox(height: AppSpacing.xl),
          summary,
        ],
        if (device.topology != null) ...[
          const SizedBox(height: AppSpacing.xl),
          DeviceTopologyPanel(topology: device.topology!),
        ],
        for (final group in visibleGroups) ...[
          const SizedBox(height: AppSpacing.xl),
          CapabilitySectionPanel(
            title: group.title,
            description: group.description,
            icon: group.icon,
            capabilities: group.capabilities,
            useGrid: group.useGrid,
            collapsible: group.collapsible,
            initiallyExpanded: group.initiallyExpanded,
            onCapabilityChanged: onCapabilityChanged,
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
    );
  }
}

class ProductStatusFact {
  const ProductStatusFact({
    required this.icon,
    required this.label,
    required this.value,
    this.tone,
  });

  final IconData icon;
  final String label;
  final String value;
  final Color? tone;
}

class ProductStatusPanel extends StatelessWidget {
  const ProductStatusPanel({super.key, required this.facts});

  final List<ProductStatusFact> facts;

  @override
  Widget build(BuildContext context) {
    return NeuCard(
      padding: const EdgeInsets.all(AppSpacing.md),
      child: LayoutBuilder(
        builder: (context, constraints) {
          final columns = constraints.maxWidth >= 680 ? 3 : 1;
          final width = columns == 1
              ? constraints.maxWidth
              : (constraints.maxWidth - AppSpacing.md * (columns - 1)) /
                  columns;
          return Wrap(
            spacing: AppSpacing.md,
            runSpacing: AppSpacing.sm,
            children: facts
                .map((fact) => SizedBox(
                      width: width,
                      child: _StatusFactTile(fact: fact),
                    ))
                .toList(),
          );
        },
      ),
    );
  }
}

class _StatusFactTile extends StatelessWidget {
  const _StatusFactTile({required this.fact});

  final ProductStatusFact fact;

  @override
  Widget build(BuildContext context) {
    final tone = fact.tone ?? context.colorScheme.primary;
    return Semantics(
      label: '${fact.label}: ${fact.value}',
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
        child: Row(
          children: [
            NeuIconBox(
              icon: fact.icon,
              size: 40,
              iconSize: 20,
              iconColor: tone,
              activeIconColor: tone,
              isActive: true,
            ),
            const SizedBox(width: AppSpacing.smMd),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(fact.label, style: context.textTheme.labelSmall),
                  const SizedBox(height: AppSpacing.xs),
                  Text(
                    fact.value,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: context.textTheme.titleSmall?.copyWith(
                      color: tone,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class ProductCapabilityGroup {
  const ProductCapabilityGroup({
    required this.title,
    required this.description,
    required this.icon,
    required this.capabilities,
    this.useGrid = false,
    this.collapsible = false,
    this.initiallyExpanded = true,
  });

  final String title;
  final String description;
  final IconData icon;
  final List<CapabilityModel> capabilities;
  final bool useGrid;
  final bool collapsible;
  final bool initiallyExpanded;
}

List<CapabilityModel> _take(
  DeviceModel device,
  Set<CapabilityModel> used, {
  required List<String> hints,
  CapabilitySection? section,
}) {
  final result = device
      .capabilitiesWhereHints(hints: hints, section: section)
      .where((capability) => !used.contains(capability))
      .toList();
  used.addAll(result);
  return result;
}

List<ProductCapabilityGroup> _remainingGroups(
  DeviceModel device,
  Set<CapabilityModel> used,
) {
  List<CapabilityModel> takeSection(CapabilitySection section) {
    final result = device.capabilities
        .where((capability) =>
            capability.section == section && !used.contains(capability))
        .toList();
    used.addAll(result);
    return result;
  }

  return [
    ProductCapabilityGroup(
      title: 'Điều khiển khác',
      description: 'Các thao tác khác được product hỗ trợ',
      icon: Icons.tune_rounded,
      capabilities: takeSection(CapabilitySection.control),
    ),
    ProductCapabilityGroup(
      title: 'Thông số khác',
      description: 'Dữ liệu mới nhất do thiết bị báo cáo',
      icon: Icons.sensors_rounded,
      capabilities: takeSection(CapabilitySection.sensor),
      useGrid: true,
    ),
    ProductCapabilityGroup(
      title: 'Chẩn đoán',
      description: 'Thông tin kỹ thuật và chất lượng kết nối',
      icon: Icons.monitor_heart_rounded,
      capabilities: takeSection(CapabilitySection.diagnostic),
      useGrid: true,
      collapsible: true,
      initiallyExpanded: false,
    ),
  ];
}

bool _truthy(dynamic value) {
  if (value is bool) return value;
  final normalised = '$value'.toLowerCase();
  return const {'true', 'on', 'active', 'streaming', 'detected'}
      .contains(normalised);
}

bool _isLocked(CapabilityModel? capability) {
  if (capability == null) return false;
  return capability.value == true ||
      '${capability.value}'.toLowerCase() == 'locked';
}

String _lockLabel(CapabilityModel? capability) {
  if (capability == null) return 'Chưa có dữ liệu';
  return _isLocked(capability) ? 'Đã khóa' : 'Đang mở khóa';
}
