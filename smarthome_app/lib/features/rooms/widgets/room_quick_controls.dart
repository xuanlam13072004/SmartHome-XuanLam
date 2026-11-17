import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';
import '../../../domain/models/device_model.dart';
import '../../dashboard/models/capability_model.dart';
import '../../dashboard/presentation/capability_actions.dart';
import '../../products/product_ui_profile.dart';
import '../../products/product_ui_registry.dart';
import '../../products/widgets/product_page_kit.dart';

/// The one most useful action of a device, as shown in a room.
class _QuickControl {
  const _QuickControl({
    required this.icon,
    required this.state,
    this.tone,
    this.actionLabel,
    this.capability,
    this.value,
    this.opensDevice = false,
    this.busy = false,
  });

  final IconData icon;
  final String state;
  final Color? tone;
  final String? actionLabel;

  /// Narrowed to the one operation to run (see [capabilityForOperation]).
  final CapabilityModel? capability;
  final dynamic value;

  /// The action opens the device page instead (camera view).
  final bool opensDevice;

  /// The device itself reports it is moving (locking, opening…).
  final bool busy;
}

int? _int(CapabilityModel? capability) {
  final value = capability?.value;
  if (value is num) return value.round();
  return int.tryParse('${value ?? ''}');
}

_QuickControl? _controlFor(BuildContext context, DeviceModel device) {
  CapabilityModel? property(String capabilityId, String propertyId) =>
      productProperty(device, capabilityId: capabilityId, propertyId: propertyId);
  final scheme = context.colorScheme;
  final warning = context.neu.warningColor;

  switch (productUiRegistry.profileOf(device)) {
    case ProductUiProfile.entranceController:
      final lock = property('door_lock', 'lock_state');
      final state = productText(lock);
      final locked = state == 'locked';
      final moving = state == 'locking' || state == 'unlocking';
      return _QuickControl(
        icon: locked ? Icons.lock_rounded : Icons.lock_open_rounded,
        state: switch (state) {
          'locked' => 'Đã khóa',
          'unlocked' => 'Chưa khóa',
          'locking' => 'Đang khóa…',
          'unlocking' => 'Đang mở khóa…',
          'fault' => 'Khóa gặp lỗi',
          _ => 'Chưa rõ',
        },
        tone: state == 'fault' ? scheme.error : locked ? scheme.primary : warning,
        actionLabel: locked ? 'Mở khóa' : 'Khóa',
        capability: moving || state == 'fault' ? null : capabilityForOperation(lock, locked ? 'unlock' : 'lock'),
        value: locked ? 'unlocking' : 'locking',
        busy: moving,
      );
    case ProductUiProfile.roofController:
      final movement = property('cover_controller', 'movement');
      final state = productText(movement);
      final opened = state == 'open' || state == 'opening';
      return _QuickControl(
        icon: Icons.roofing_rounded,
        state: switch (state) {
          'open' => 'Mái đang mở',
          'closed' => 'Mái đã đóng',
          'opening' => 'Đang mở mái…',
          'closing' => 'Đang đóng mái…',
          _ => 'Chưa rõ',
        },
        tone: state == 'opening' || state == 'closing' ? warning : scheme.primary,
        actionLabel: opened ? 'Đóng mái' : 'Mở mái',
        capability: capabilityForOperation(movement, opened ? 'close' : 'open'),
        value: opened ? 'closing' : 'opening',
      );
    case ProductUiProfile.irrigationManager:
      final pump = property('irrigation_pump', 'pump_output_state');
      final running = productText(pump) == 'running';
      final moisture = property('soil_moisture_measurement', 'moisture_level')?.value;
      final empty = productText(property('water_level_measurement', 'water_availability')) == 'empty';
      final maximum = (_int(property('irrigation_policy', 'maximum_runtime_seconds')) ?? 900).clamp(30, 3600);
      final seconds = (_int(property('irrigation_policy', 'default_cycle_duration_seconds')) ?? 300).clamp(30, maximum);
      return _QuickControl(
        icon: running ? Icons.water_rounded : Icons.grass_rounded,
        state: running
            ? 'Đang tưới'
            : empty
                ? 'Bể đã cạn nước'
                : moisture is num
                    ? 'Độ ẩm đất ${moisture.round()}%'
                    : 'Đang nghỉ',
        tone: empty && !running ? scheme.error : scheme.primary,
        actionLabel: running ? 'Dừng tưới' : 'Tưới ${productDurationLabel(seconds)}',
        capability: running
            ? capabilityForOperation(pump, 'stop')
            : empty
                ? null
                : capabilityForOperation(pump, 'water_for_duration'),
        value: running ? 'stopped' : seconds,
      );
    case ProductUiProfile.hazardMonitor:
      final siren = property('alarm_siren', 'audible_state');
      final sounding = productText(siren) == 'sounding';
      final risk = productText(property('hazard_controller', 'risk_level'));
      final flame = productText(property('flame_detection', 'flame_detected')) == 'true';
      final danger = flame || risk == 'alarm' || risk == 'emergency';
      final caution = risk == 'warning' || risk == 'sensor_fault';
      final mute = sounding ? capabilityForOperation(siren, 'mute_siren') : null;
      final allowed = (mute?.operations.single.inputSchema['duration_seconds'] as Map?)?['enum'];
      final seconds = allowed is List && allowed.whereType<num>().isNotEmpty
          ? allowed.whereType<num>().map((value) => value.toInt()).reduce((a, b) => a < b ? a : b)
          : 60;
      return _QuickControl(
        icon: danger || caution ? Icons.warning_rounded : Icons.verified_user_rounded,
        state: sounding
            ? 'Còi đang hú'
            : danger
                ? (flame ? 'Phát hiện lửa' : 'Báo động')
                : caution
                    ? (risk == 'sensor_fault' ? 'Cảm biến lỗi' : 'Cần chú ý')
                    : 'An toàn',
        tone: danger || sounding ? scheme.error : caution ? warning : context.neu.deviceOnline,
        actionLabel: sounding ? 'Tắt còi' : null,
        capability: mute,
        value: seconds,
      );
    case ProductUiProfile.securityCamera:
      return _QuickControl(
        icon: Icons.videocam_rounded,
        state: 'Camera an ninh',
        tone: scheme.primary,
        actionLabel: 'Xem',
        opensDevice: true,
      );
    default:
      return null;
  }
}

/// "Điều khiển nhanh": one row per device with its key state and main action.
/// Protected operations still ask for confirmation or the password.
class RoomQuickControls extends ConsumerStatefulWidget {
  const RoomQuickControls({super.key, required this.devices});

  final List<DeviceModel> devices;

  @override
  ConsumerState<RoomQuickControls> createState() => _RoomQuickControlsState();
}

class _RoomQuickControlsState extends ConsumerState<RoomQuickControls> {
  final Set<String> _pending = {};

  Future<void> _run(DeviceModel device, _QuickControl control) async {
    if (control.opensDevice) {
      context.push('/device/${device.mac}');
      return;
    }
    final capability = control.capability;
    if (capability == null || _pending.contains(device.mac)) return;
    setState(() => _pending.add(device.mac));
    try {
      await applyCapabilityChange(context, ref, device, capability, control.value);
    } finally {
      if (mounted) setState(() => _pending.remove(device.mac));
    }
  }

  @override
  Widget build(BuildContext context) {
    final rows = [
      for (final device in widget.devices)
        if (_controlFor(context, device) case final control?) (device, control),
    ];
    if (rows.isEmpty) return const SizedBox.shrink();
    return NeuCard(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.xs),
      child: Column(
        children: [
          for (var index = 0; index < rows.length; index++) ...[
            if (index > 0) const Divider(height: 1, indent: AppSpacing.md, endIndent: AppSpacing.md),
            _QuickControlRow(
              device: rows[index].$1,
              control: rows[index].$2,
              pending: _pending.contains(rows[index].$1.mac),
              onAction: () => _run(rows[index].$1, rows[index].$2),
            ),
          ],
        ],
      ),
    );
  }
}

class _QuickControlRow extends StatelessWidget {
  const _QuickControlRow({
    required this.device,
    required this.control,
    required this.pending,
    required this.onAction,
  });

  final DeviceModel device;
  final _QuickControl control;
  final bool pending;
  final VoidCallback onAction;

  @override
  Widget build(BuildContext context) {
    final scheme = context.colorScheme;
    final online = productOnline(device);
    final tone = online ? (control.tone ?? scheme.primary) : scheme.onSurfaceVariant;
    final label = control.actionLabel;
    final enabled = online && !pending && !control.busy && (control.opensDevice || control.capability != null);

    return InkWell(
      onTap: () => context.push('/device/${device.mac}'),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.smMd),
        child: Row(
          children: [
            ProductToneIcon(icon: control.icon, tone: tone, size: 38),
            const SizedBox(width: AppSpacing.smMd),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    device.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: context.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700),
                  ),
                  Text(
                    online ? control.state : 'Ngoại tuyến',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: context.textTheme.bodySmall?.copyWith(color: tone, fontWeight: FontWeight.w600),
                  ),
                ],
              ),
            ),
            if (label != null) ...[
              const SizedBox(width: AppSpacing.sm),
              pending || (online && control.busy)
                  ? const Padding(
                      padding: EdgeInsets.symmetric(horizontal: AppSpacing.md),
                      child: SizedBox.square(dimension: 20, child: CircularProgressIndicator(strokeWidth: 2)),
                    )
                  : FilledButton.tonal(
                      onPressed: enabled ? onAction : null,
                      style: FilledButton.styleFrom(
                        visualDensity: VisualDensity.compact,
                        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
                      ),
                      child: Text(label),
                    ),
            ],
          ],
        ),
      ),
    );
  }
}
