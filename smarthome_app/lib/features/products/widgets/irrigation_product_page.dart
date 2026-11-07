// Hallmark · irrigation page · watering now? → water now (duration) → soil & tank → automatic → activity
import 'package:flutter/material.dart';

import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';
import '../../../domain/models/device_model.dart';
import '../../dashboard/models/capability_model.dart';
import 'product_mini_cards.dart';
import 'product_page_kit.dart';

class IrrigationProductDetail extends StatefulWidget {
  const IrrigationProductDetail({
    super.key,
    required this.device,
    required this.onCapabilityChanged,
    this.activitySection,
  });

  final DeviceModel device;
  final ProductCapabilityChanged onCapabilityChanged;
  final Widget? activitySection;

  @override
  State<IrrigationProductDetail> createState() => _IrrigationProductDetailState();
}

class _IrrigationProductDetailState extends State<IrrigationProductDetail> {
  String? _pending;
  int? _selectedSeconds;

  DeviceModel get _device => widget.device;

  CapabilityModel? _property(String capabilityId, String propertyId) =>
      productProperty(_device, capabilityId: capabilityId, propertyId: propertyId);

  int? _int(CapabilityModel? capability) {
    final value = capability?.value;
    if (value is num) return value.round();
    return int.tryParse('${value ?? ''}');
  }

  Future<void> _run(CapabilityModel? capability, String key, dynamic value) async {
    if (capability == null || _pending != null) return;
    setState(() => _pending = key);
    try {
      await widget.onCapabilityChanged(capability, value);
    } finally {
      if (mounted) setState(() => _pending = null);
    }
  }

  List<int> _durationOptions(int maximum, int configured) {
    final options = <int>{60, 300, 600, 900, configured}
        .where((seconds) => seconds >= 30 && seconds <= maximum)
        .toList()
      ..sort();
    return options.isEmpty ? [maximum] : options;
  }

  @override
  Widget build(BuildContext context) {
    final pump = _property('irrigation_pump', 'pump_output_state');
    final runtime = _int(_property('irrigation_pump', 'runtime_seconds'));
    final stopReason = productText(_property('irrigation_pump', 'stop_reason'));
    final mode = _property('irrigation_policy', 'control_mode');
    final moisture = _property('soil_moisture_measurement', 'moisture_level')?.value;
    final soilSensor = productText(_property('soil_moisture_measurement', 'sensor_state'));
    final tankLevel = _property('water_level_measurement', 'level_normalized')?.value;
    final water = productText(_property('water_level_measurement', 'water_availability'));
    final target = _int(_property('irrigation_policy', 'target_moisture'));
    final cycle = _int(_property('irrigation_policy', 'default_cycle_duration_seconds')) ?? 300;
    final maximum = (_int(_property('irrigation_policy', 'maximum_runtime_seconds')) ?? 900).clamp(30, 3600);
    final cooldown = _int(_property('irrigation_policy', 'cooldown_seconds'));

    final running = productText(pump) == 'running';
    final automatic = productText(mode) == 'automatic';
    final online = productOnline(_device);
    final start = capabilityForOperation(pump, 'water_for_duration');
    final stop = capabilityForOperation(pump, 'stop');
    final setMode = capabilityForOperation(mode, 'set_control_mode');
    final options = _durationOptions(maximum, cycle.clamp(30, maximum));
    final selected = options.contains(_selectedSeconds)
        ? _selectedSeconds!
        : options.contains(cycle) ? cycle : options.first;
    final waterTone = context.colorScheme.primary;
    final noWater = water == 'empty';

    String? caption;
    if (!online) {
      caption = 'Thiết bị đang ngoại tuyến';
    } else if ((running ? stop : start) == null) {
      caption = 'Bạn không có quyền điều khiển bơm';
    } else if (running) {
      caption = runtime == null ? 'Bơm đang chạy' : 'Đã tưới ${productDurationLabel(runtime)}';
    } else if (noWater) {
      caption = 'Bể đã cạn nước, bơm sẽ không chạy';
    } else {
      caption = 'Tưới trong ${productDurationLabel(selected)}';
    }

    return ProductPage(
      children: [
        ProductStatusHeader(
          device: _device,
          icon: running ? Icons.water_rounded : Icons.grass_rounded,
          status: running ? 'Đang tưới' : 'Đang nghỉ',
          detail: running
              ? (automatic ? 'Lượt tưới tự động' : 'Lượt tưới thủ công')
              : [
                  automatic ? 'Tự động tưới khi đất khô' : 'Tưới thủ công',
                  if (_stopReason(stopReason) != null) 'Lần trước: ${_stopReason(stopReason)}',
                ].join(' · '),
          tone: running ? waterTone : context.neu.deviceOnline,
        ),
        NeuCard(
          padding: const EdgeInsets.symmetric(vertical: AppSpacing.lg, horizontal: AppSpacing.md),
          child: Column(
            children: [
              ProductPrimaryControl(
                icon: running ? Icons.stop_rounded : Icons.water_drop_rounded,
                label: running ? 'Dừng tưới' : 'Tưới ngay',
                caption: caption,
                tone: running ? context.colorScheme.error : waterTone,
                active: running,
                busy: _pending == 'pump',
                onPressed: online && (running ? stop : start) != null && (running || !noWater)
                    ? () => _run(running ? stop : start, 'pump', running ? 'stopped' : selected)
                    : null,
              ),
              if (!running && start != null) ...[
                const SizedBox(height: AppSpacing.lg),
                Wrap(
                  alignment: WrapAlignment.center,
                  spacing: AppSpacing.sm,
                  runSpacing: AppSpacing.sm,
                  children: [
                    for (final seconds in options)
                      ChoiceChip(
                        label: Text(productDurationLabel(seconds)),
                        selected: seconds == selected,
                        showCheckmark: false,
                        onSelected: online && _pending == null
                            ? (_) => setState(() => _selectedSeconds = seconds)
                            : null,
                      ),
                  ],
                ),
              ],
            ],
          ),
        ),
        ProductReadingGrid(
          readings: [
            ProductReading(
              icon: Icons.eco_rounded,
              label: 'Độ ẩm đất',
              value: moisture is num ? '${moisture.round()}%' : '—',
              caption: soilSensor == 'fault'
                  ? 'Cảm biến cần kiểm tra'
                  : target == null
                      ? null
                      : 'Mục tiêu $target%',
              tone: soilSensor == 'fault' ? context.neu.warningColor : null,
            ),
            ProductReading(
              icon: Icons.water_rounded,
              label: 'Bể nước',
              value: tankLevel is num ? '${tankLevel.round()}%' : _waterLabel(water),
              caption: tankLevel is num ? _waterLabel(water) : null,
              tone: noWater
                  ? context.colorScheme.error
                  : water == 'low'
                      ? context.neu.warningColor
                      : null,
            ),
          ],
        ),
        ProductSection(
          title: 'Cài đặt',
          child: ProductSettingsCard(
            children: [
              ProductSettingTile(
                icon: Icons.auto_mode_rounded,
                title: 'Tự động tưới',
                subtitle: target == null
                    ? 'Thiết bị tự tưới khi đất khô'
                    : 'Giữ độ ẩm đất quanh $target%, mỗi lần ${productDurationLabel(cycle)}',
                enabled: online && setMode != null,
                trailing: _pending == 'mode'
                    ? const ProductButtonSpinner()
                    : Switch(
                        value: automatic,
                        onChanged: online && setMode != null && _pending == null
                            ? (value) => _run(setMode, 'mode', value ? 'automatic' : 'manual')
                            : null,
                      ),
              ),
              ProductSettingTile(
                icon: Icons.shield_outlined,
                title: 'Bảo vệ máy bơm',
                subtitle: [
                  'Tối đa ${productDurationLabel(maximum)} mỗi lần',
                  if (cooldown != null && cooldown > 0) 'nghỉ ${productDurationLabel(cooldown)} giữa hai lần',
                  'tự dừng khi bể cạn',
                ].join(', '),
              ),
            ],
          ),
        ),
        if (widget.activitySection != null) widget.activitySection!,
      ],
    );
  }
}

String _waterLabel(String availability) => switch (availability) {
      'available' => 'Đủ nước',
      'low' => 'Sắp hết',
      'empty' => 'Đã cạn',
      _ => 'Chưa rõ',
    };

String? _stopReason(String reason) => switch (reason) {
      'completed' => 'tưới xong',
      'user_request' => 'dừng theo yêu cầu',
      'low_water' => 'bể sắp hết nước',
      'reservoir_sensor_fault' => 'không đọc được mực nước',
      'maximum_runtime' => 'chạm giới hạn an toàn',
      'controller_restart' => 'thiết bị khởi động lại',
      _ => null,
    };
