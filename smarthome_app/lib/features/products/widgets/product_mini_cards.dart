// Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V5
// Hallmark · modern-minimal · product identity → live state → two decisive facts
import 'package:flutter/material.dart';

import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';
import '../../../domain/models/device_model.dart';
import '../../dashboard/models/capability_model.dart';
import '../product_capability_query.dart';

typedef ProductCapabilityChanged = Future<void> Function(
    CapabilityModel capability, dynamic value);

class GenericProductMiniCard extends StatelessWidget {
  const GenericProductMiniCard({
    super.key,
    required this.device,
    required this.onTap,
    required this.onCapabilityChanged,
  });

  final DeviceModel device;
  final VoidCallback onTap;
  final ProductCapabilityChanged onCapabilityChanged;

  @override
  Widget build(BuildContext context) {
    final power = device.primaryOnOff;
    final online = device.status == DeviceStatus.online;
    return DeviceCard(
      title: device.name,
      icon: device.icon,
      status: device.status,
      iconColor: device.isPrimaryOn ? context.colorScheme.primary : null,
      actionWidget: power != null && online
          ? NeuToggle(
              value: power.value as bool? ?? false,
              onChanged: (value) => onCapabilityChanged(power, value),
              width: 44,
              height: 24,
            )
          : null,
      capabilities: device.capabilities,
      isPrimaryOn: device.isPrimaryOn,
      glowColor: AppPalette.colorForCategory(device.category),
      connectionIcon: _connectionIcon(device),
      connectionLabel: device.topology?.connectionLabel,
      onTap: onTap,
    );
  }
}

String _doorStateLabel(String value) => switch (value.toLowerCase()) {
      'closed' => 'Đã đóng',
      'open' => 'Đang mở',
      'opening' => 'Đang mở ra',
      'closing' => 'Đang đóng lại',
      _ => 'Không rõ',
    };

class EntranceProductMiniCard extends StatelessWidget {
  const EntranceProductMiniCard({
    super.key,
    required this.device,
    required this.onTap,
  });

  final DeviceModel device;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final lock = device.capabilityMatching(
      ids: const ['lock_state'],
      capabilityIds: const ['door_lock'],
    );
    final door = device.capabilityMatching(
      ids: const ['door_state'],
      capabilityIds: const ['door_position'],
    );
    final pin = device.capabilityMatching(ids: const ['pin_configured']);
    final state = '${lock?.value}'.toLowerCase();
    final locked = state == 'locked' || lock?.value == true;
    return ProductMiniCardFrame(
      device: device,
      onTap: onTap,
      icon: locked ? Icons.lock_rounded : Icons.lock_open_rounded,
      eyebrow: 'CỬA CHÍNH',
      statusLabel: switch (state) {
        'locked' => 'Đã khóa',
        'unlocked' => 'Đã mở khóa',
        'locking' => 'Đang khóa…',
        'unlocking' => 'Đang mở khóa…',
        'fault' => 'Khóa gặp lỗi',
        _ => 'Chưa rõ',
      },
      accent: locked ? context.colorScheme.primary : context.neu.warningColor,
      metrics: [
        ProductMiniMetric(
          icon: Icons.door_front_door_rounded,
          label: 'Cửa',
          value: _doorStateLabel('${door?.value}'),
        ),
        ProductMiniMetric(
          icon: Icons.dialpad_rounded,
          label: 'Mã PIN',
          value: pin?.value == true ? 'Đã cài' : 'Chưa cài',
        ),
      ],
    );
  }
}

class RoofProductMiniCard extends StatelessWidget {
  const RoofProductMiniCard({
    super.key,
    required this.device,
    required this.onTap,
  });

  final DeviceModel device;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final rain = device.capabilityMatching(
      ids: const ['rain_detected'],
      capabilityIds: const ['rain_detection'],
    );
    final movement = device.capabilityMatching(
      ids: const ['movement'],
      capabilityIds: const ['cover_controller'],
    );
    final mode = device.capabilityMatching(ids: const ['control_mode'], capabilityIds: const ['roof_policy']);
    final raining = rain?.value == true || '${rain?.value}'.toLowerCase() == 'true';
    final state = '${movement?.value}'.toLowerCase();
    return ProductMiniCardFrame(
      device: device,
      onTap: onTap,
      icon: Icons.roofing_rounded,
      eyebrow: 'MÁI CHE',
      statusLabel: switch (state) {
        'open' => 'Đang mở',
        'closed' => 'Đã đóng',
        'opening' => 'Đang mở ra…',
        'closing' => 'Đang đóng lại…',
        _ => 'Chưa rõ',
      },
      accent: state == 'opening' || state == 'closing' ? context.neu.warningColor : context.colorScheme.primary,
      metrics: [
        ProductMiniMetric(
          icon: raining ? Icons.water_drop_rounded : Icons.wb_sunny_rounded,
          label: 'Thời tiết',
          value: raining ? 'Đang mưa' : 'Khô ráo',
        ),
        ProductMiniMetric(
          icon: Icons.auto_mode_rounded,
          label: 'Chế độ',
          value: '${mode?.value}'.toLowerCase() == 'automatic' ? 'Tự động' : 'Thủ công',
        ),
      ],
    );
  }
}

class HazardProductMiniCard extends StatelessWidget {
  const HazardProductMiniCard({
    super.key,
    required this.device,
    required this.onTap,
  });

  final DeviceModel device;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final flame = device.capabilityMatching(
      ids: const ['flame_detected'],
      capabilityIds: const ['flame_detection'],
    );
    final gas = device.capabilityMatching(ids: const ['gas_level'], capabilityIds: const ['gas_measurement']);
    final risk = '${device.capabilityMatching(ids: const ['risk_level'])?.value}'.toLowerCase();
    final flameDetected = flame?.value == true;
    final danger = flameDetected || risk == 'alarm' || risk == 'emergency';
    final caution = risk == 'warning' || risk == 'sensor_fault';
    final gasValue = gas?.value;
    return ProductMiniCardFrame(
      device: device,
      onTap: onTap,
      icon: danger || caution ? Icons.warning_rounded : Icons.verified_user_rounded,
      eyebrow: 'AN TOÀN BẾP',
      statusLabel: danger
          ? (flameDetected ? 'Phát hiện lửa' : 'Báo động')
          : caution
              ? (risk == 'sensor_fault' ? 'Cảm biến lỗi' : 'Cần chú ý')
              : 'An toàn',
      accent: danger
          ? context.colorScheme.error
          : caution
              ? context.neu.warningColor
              : context.neu.deviceOnline,
      metrics: [
        ProductMiniMetric(
          icon: Icons.air_rounded,
          label: 'Khí gas',
          value: gasValue is num ? '${gasValue.round()}%' : '—',
        ),
        ProductMiniMetric(
          icon: Icons.local_fire_department_rounded,
          label: 'Lửa',
          value: flame?.value == null ? '—' : flameDetected ? 'Phát hiện' : 'Không có',
        ),
      ],
    );
  }
}

class IrrigationProductMiniCard extends StatelessWidget {
  const IrrigationProductMiniCard({
    super.key,
    required this.device,
    required this.onTap,
  });

  final DeviceModel device;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final moisture = device.capabilityMatching(
      ids: const ['moisture_level'],
      capabilityIds: const ['soil_moisture_measurement'],
    );
    final water = device.capabilityMatching(ids: const ['water_availability'], capabilityIds: const ['water_level_measurement']);
    final pump = device.capabilityMatching(
      ids: const ['pump_output_state'],
      capabilityIds: const ['irrigation_pump'],
    );
    final pumping = _isActiveState(pump?.value);
    final moistureValue = moisture?.value;
    final waterState = '${water?.value}'.toLowerCase();
    return ProductMiniCardFrame(
      device: device,
      onTap: onTap,
      icon: pumping ? Icons.water_rounded : Icons.grass_rounded,
      eyebrow: 'TƯỚI CÂY',
      statusLabel: pumping ? 'Đang tưới' : 'Đang nghỉ',
      accent: context.colorScheme.primary,
      metrics: [
        ProductMiniMetric(
          icon: Icons.eco_rounded,
          label: 'Độ ẩm đất',
          value: moistureValue is num ? '${moistureValue.round()}%' : '—',
        ),
        ProductMiniMetric(
          icon: Icons.water_drop_outlined,
          label: 'Bể nước',
          value: switch (waterState) {
            'available' => 'Đủ nước',
            'low' => 'Sắp hết',
            'empty' => 'Đã cạn',
            _ => '—',
          },
        ),
      ],
    );
  }
}

bool _isActiveState(dynamic value) {
  if (value is bool) return value;
  return const {'on', 'active', 'running', 'true'}
      .contains('$value'.toLowerCase());
}

class ProductMiniMetric {
  const ProductMiniMetric({
    required this.icon,
    required this.label,
    required this.value,
  });

  final IconData icon;
  final String label;
  final String value;
}

class ProductMiniCardFrame extends StatelessWidget {
  const ProductMiniCardFrame({
    super.key,
    required this.device,
    required this.onTap,
    required this.icon,
    required this.eyebrow,
    required this.statusLabel,
    required this.accent,
    required this.metrics,
    this.showConnection = true,
  });

  final DeviceModel device;
  final VoidCallback onTap;
  /// Hub–Node connection icon; off for Products that never join Hub–Node.
  final bool showConnection;
  final IconData icon;
  final String eyebrow;
  final String statusLabel;
  final Color accent;
  final List<ProductMiniMetric> metrics;

  @override
  Widget build(BuildContext context) {
    final offline = device.status == DeviceStatus.offline;
    return Semantics(
      button: true,
      label: '$eyebrow, ${device.name}, $statusLabel',
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: AnimatedOpacity(
          duration: const Duration(milliseconds: 220),
          opacity: offline ? 0.58 : 1,
          child: NeuContainer(
            padding: const EdgeInsets.all(AppSpacing.md),
            borderRadius: AppRadius.lg,
            depth: NeuDepth.raisedMedium,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    NeuIconBox(
                      icon: icon,
                      size: 42,
                      iconSize: 21,
                      isActive: !offline,
                      iconColor: accent,
                      activeIconColor: accent,
                    ),
                    const Spacer(),
                    StatusBadge(status: device.status, size: 9),
                    if (showConnection && device.topology != null) ...[
                      const SizedBox(width: AppSpacing.sm),
                      Icon(
                        _connectionIcon(device),
                        size: 16,
                        color: context.colorScheme.onSurfaceVariant,
                      ),
                    ],
                  ],
                ),
                const SizedBox(height: AppSpacing.smMd),
                Text(
                  eyebrow,
                  style: context.textTheme.labelSmall?.copyWith(
                    color: accent,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 0.9,
                  ),
                ),
                const SizedBox(height: AppSpacing.xs),
                Text(
                  device.name,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: context.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w700,
                    height: 1.15,
                  ),
                ),
                const SizedBox(height: AppSpacing.xs),
                Text(
                  offline ? 'Ngoại tuyến' : statusLabel,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: context.textTheme.bodySmall?.copyWith(
                    color:
                        offline ? context.colorScheme.onSurfaceVariant : accent,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const Spacer(),
                ...metrics.take(2).map(
                      (metric) => Padding(
                        padding: const EdgeInsets.only(top: AppSpacing.sm),
                        child: Row(
                          children: [
                            Icon(
                              metric.icon,
                              size: 15,
                              color: context.colorScheme.onSurfaceVariant,
                            ),
                            const SizedBox(width: AppSpacing.sm),
                            Expanded(
                              child: Text(
                                metric.label,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: context.textTheme.labelSmall,
                              ),
                            ),
                            const SizedBox(width: AppSpacing.xs),
                            Flexible(
                              child: Text(
                                metric.value,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                textAlign: TextAlign.end,
                                style: context.textTheme.labelMedium?.copyWith(
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

IconData? _connectionIcon(DeviceModel device) {
  final topology = device.topology;
  if (topology == null) return null;
  if (topology.isHub) return Icons.hub_rounded;
  if (topology.usesDirectFallback) return Icons.cloud_done_rounded;
  return Icons.device_hub_rounded;
}
