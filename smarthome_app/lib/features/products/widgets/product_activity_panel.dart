// Hallmark · activity · newest first → what happened → who/what caused it → when
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';
import '../../../domain/models/device_event_model.dart';
import '../../../domain/models/device_model.dart';
import '../../dashboard/providers/device_events_provider.dart';
import '../product_ui_profile.dart';
import 'product_page_kit.dart';

class ActivityEntry {
  const ActivityEntry(this.icon, this.title, this.detail, this.tone);

  final IconData icon;
  final String title;
  final String detail;
  final Color tone;
}

typedef ActivityDescriber = ActivityEntry? Function(BuildContext context, DeviceEventModel event);

/// "Hoạt động gần đây" of a device (owner only: the Gateway refuses others).
class ProductActivityPanel extends ConsumerWidget {
  const ProductActivityPanel({super.key, required this.device, this.limit = 8});

  final DeviceModel device;
  final int limit;

  static String titleFor(DeviceModel device) =>
      device.uiProfile == ProductUiProfile.entranceController ? 'Lịch sử ra vào' : 'Hoạt động gần đây';

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final events = ref.watch(deviceEventsProvider(device.mac));
    final describe = _describerFor(device.uiProfile);
    return ProductSection(
      title: titleFor(device),
      trailing: IconButton(
        tooltip: 'Tải lại',
        visualDensity: VisualDensity.compact,
        onPressed: () => ref.invalidate(deviceEventsProvider(device.mac)),
        icon: const Icon(Icons.refresh_rounded, size: 20),
      ),
      child: NeuCard(
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.xs),
        child: events.when(
          loading: () => const Padding(
            padding: EdgeInsets.all(AppSpacing.lg),
            child: Center(child: CircularProgressIndicator()),
          ),
          error: (_, __) => _Message(
            icon: Icons.history_toggle_off_rounded,
            text: 'Chưa tải được hoạt động. Vui lòng thử lại.',
            action: TextButton(
              onPressed: () => ref.invalidate(deviceEventsProvider(device.mac)),
              child: const Text('Thử lại'),
            ),
          ),
          data: (items) {
            final entries = <(ActivityEntry, DateTime)>[];
            for (final event in items) {
              final entry = describe(context, event);
              if (entry != null) entries.add((entry, event.occurredAt));
              if (entries.length >= limit) break;
            }
            if (entries.isEmpty) {
              return const _Message(icon: Icons.event_note_outlined, text: 'Chưa có hoạt động nào.');
            }
            return Column(
              children: [
                for (var index = 0; index < entries.length; index++) ...[
                  if (index > 0)
                    Divider(height: 1, indent: 52, color: context.colorScheme.outlineVariant.withValues(alpha: 0.6)),
                  _ActivityRow(entry: entries[index].$1, time: entries[index].$2),
                ],
              ],
            );
          },
        ),
      ),
    );
  }
}

class _ActivityRow extends StatelessWidget {
  const _ActivityRow({required this.entry, required this.time});

  final ActivityEntry entry;
  final DateTime time;

  @override
  Widget build(BuildContext context) => Semantics(
        label: '${entry.title}. ${entry.detail}. ${_when(time)}',
        child: ExcludeSemantics(
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: AppSpacing.smMd),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ProductToneIcon(icon: entry.icon, tone: entry.tone, size: 36),
                const SizedBox(width: AppSpacing.smMd),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(entry.title, style: context.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600)),
                      if (entry.detail.isNotEmpty)
                        Text(
                          entry.detail,
                          style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
                        ),
                    ],
                  ),
                ),
                const SizedBox(width: AppSpacing.sm),
                Text(
                  _when(time),
                  style: context.textTheme.labelSmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
                ),
              ],
            ),
          ),
        ),
      );
}

String _when(DateTime time) {
  final local = time.toLocal();
  final now = DateTime.now();
  String two(int value) => value.toString().padLeft(2, '0');
  final clock = '${two(local.hour)}:${two(local.minute)}';
  if (local.year == now.year && local.month == now.month && local.day == now.day) return clock;
  return '$clock ${two(local.day)}/${two(local.month)}';
}

class _Message extends StatelessWidget {
  const _Message({required this.icon, required this.text, this.action});

  final IconData icon;
  final String text;
  final Widget? action;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.lg),
        child: Column(
          children: [
            Icon(icon, color: context.colorScheme.onSurfaceVariant),
            const SizedBox(height: AppSpacing.sm),
            Text(text, textAlign: TextAlign.center, style: context.textTheme.bodySmall),
            if (action != null) action!,
          ],
        ),
      );
}

// ------------------------------------------------------------ describers

ActivityDescriber _describerFor(String profile) => switch (profile) {
      ProductUiProfile.entranceController => _entrance,
      ProductUiProfile.roofController => _roof,
      ProductUiProfile.hazardMonitor => _hazard,
      ProductUiProfile.irrigationManager => _irrigation,
      _ => (_, __) => null,
    };

String _source(dynamic value) => switch ('$value') {
      'keypad' => 'bàn phím',
      'remote' => 'ứng dụng',
      'local' || 'local_button' => 'nút trên thiết bị',
      'automatic' => 'chế độ tự động',
      'boot_recovery' => 'khởi động lại',
      _ => 'thiết bị',
    };

ActivityEntry? _entrance(BuildContext context, DeviceEventModel event) {
  final data = event.data;
  final primary = context.colorScheme.primary;
  final error = context.colorScheme.error;
  return switch (event.eventName) {
    'pin_access_granted' => ActivityEntry(Icons.key_rounded, 'Mở bằng mã PIN', 'Mã PIN hợp lệ', primary),
    'pin_access_denied' => ActivityEntry(
        Icons.key_off_rounded, 'Nhập sai mã PIN', 'Còn ${data['attempts_remaining'] ?? 0} lần thử', error),
    'pin_locked_out' => ActivityEntry(
        Icons.lock_clock_rounded, 'Bàn phím tạm khóa', 'Thử lại sau ${data['lockout_seconds'] ?? 30} giây', error),
    'door_opened' => ActivityEntry(Icons.door_front_door_rounded, 'Cửa được mở', '', primary),
    'door_closed' => ActivityEntry(Icons.door_back_door_rounded, 'Cửa được đóng', 'Cửa sẽ tự khóa sau ít giây', primary),
    'door_position_fault' => ActivityEntry(
        Icons.warning_amber_rounded, 'Không xác định được vị trí cửa', 'Tự khóa tạm dừng để an toàn', error),
    'lock_changed' => switch ('${data['state']}') {
        'locked' => ActivityEntry(Icons.lock_rounded, 'Đã khóa cửa', 'Từ ${_source(data['source'])}', primary),
        'unlocked' => ActivityEntry(Icons.lock_open_rounded, 'Đã mở khóa', 'Từ ${_source(data['source'])}', primary),
        'fault' => ActivityEntry(Icons.error_outline_rounded, 'Khóa gặp lỗi', '', error),
        _ => null,
      },
    _ => null,
  };
}

ActivityEntry? _roof(BuildContext context, DeviceEventModel event) {
  final data = event.data;
  final primary = context.colorScheme.primary;
  final rain = context.colorScheme.secondary;
  return switch (event.eventName) {
    'motion_started' => '${data['direction']}' == 'opening'
        ? ActivityEntry(Icons.unfold_more_rounded, 'Bắt đầu mở mái', 'Từ ${_source(data['source'])}', primary)
        : ActivityEntry(Icons.unfold_less_rounded, 'Bắt đầu đóng mái', 'Từ ${_source(data['source'])}', primary),
    'motion_completed' => '${data['state']}' == 'open'
        ? ActivityEntry(Icons.roofing_rounded, 'Mái đã mở', '', primary)
        : ActivityEntry(Icons.roofing_rounded, 'Mái đã đóng', '', primary),
    'rain_started' => ActivityEntry(Icons.water_drop_rounded, 'Trời bắt đầu mưa', '', rain),
    'rain_stopped' => ActivityEntry(Icons.wb_sunny_rounded, 'Trời tạnh mưa', '', primary),
    'button_pressed' => ActivityEntry(Icons.touch_app_rounded, 'Bấm nút tại chỗ', '', primary),
    _ => null,
  };
}

ActivityEntry? _hazard(BuildContext context, DeviceEventModel event) {
  final data = event.data;
  final primary = context.colorScheme.primary;
  final error = context.colorScheme.error;
  final warning = context.neu.warningColor;
  final cause = switch ('${data['cause']}') {
    'gas' => 'Rò rỉ khí gas',
    'smoke' => 'Phát hiện khói',
    'flame' => 'Phát hiện lửa',
    'sensor_fault' => 'Cảm biến gặp lỗi',
    'multiple' => 'Nhiều nguy cơ cùng lúc',
    _ => 'Nguy cơ an toàn',
  };
  return switch (event.eventName) {
    'incident_started' => ActivityEntry(Icons.warning_rounded, 'Báo động', cause, error),
    'incident_acknowledged' =>
      ActivityEntry(Icons.task_alt_rounded, 'Đã xác nhận sự cố', 'Từ ${_source(data['source'])}', warning),
    'incident_resolved' => ActivityEntry(Icons.verified_rounded, 'Sự cố đã kết thúc', '', context.neu.deviceOnline),
    'siren_muted' => ActivityEntry(Icons.volume_off_rounded, 'Tắt còi tạm thời',
        '${productDurationLabel((data['duration_seconds'] as num?)?.toInt() ?? 60)} · từ ${_source(data['source'])}', warning),
    'siren_tested' => ActivityEntry(Icons.campaign_rounded, 'Thử còi', '', primary),
    'gas_threshold_crossed' => ActivityEntry(Icons.air_rounded, 'Khí gas vượt ngưỡng', '', error),
    'smoke_threshold_crossed' => ActivityEntry(Icons.cloud_rounded, 'Khói vượt ngưỡng', '', error),
    'flame_detected' => ActivityEntry(Icons.local_fire_department_rounded, 'Phát hiện lửa', '', error),
    'button_pressed' => ActivityEntry(Icons.touch_app_rounded, 'Bấm nút tắt âm tại chỗ', '', primary),
    _ => null,
  };
}

ActivityEntry? _irrigation(BuildContext context, DeviceEventModel event) {
  final data = event.data;
  final primary = context.colorScheme.primary;
  final warning = context.neu.warningColor;
  String reason(dynamic value) => switch ('$value') {
        'completed' => 'Hoàn thành',
        'user_request' => 'Dừng theo yêu cầu',
        'low_water' => 'Bể sắp hết nước',
        'reservoir_sensor_fault' || 'reservoir_unknown' => 'Không đọc được mực nước',
        'maximum_runtime' => 'Chạm giới hạn an toàn',
        'controller_restart' => 'Thiết bị khởi động lại',
        'cooldown' => 'Bơm đang nghỉ',
        'invalid_duration' => 'Thời gian không hợp lệ',
        'cycle_active' => 'Đang có lượt tưới khác',
        'soil_sensor_fault' => 'Cảm biến độ ẩm lỗi',
        _ => '',
      };
  return switch (event.eventName) {
    'watering_started' => ActivityEntry(Icons.water_drop_rounded, 'Bắt đầu tưới',
        '${productDurationLabel((data['duration_seconds'] as num?)?.toInt() ?? 0)} · từ ${_source(data['source'])}', primary),
    'watering_stopped' => ActivityEntry(Icons.stop_circle_outlined, 'Dừng tưới',
        [reason(data['reason']), if (data['runtime_seconds'] is num) 'chạy ${productDurationLabel((data['runtime_seconds'] as num).toInt())}']
            .where((part) => part.isNotEmpty)
            .join(' · '),
        primary),
    'watering_rejected' => ActivityEntry(Icons.block_rounded, 'Không thể tưới', reason(data['reason']), warning),
    'automatic_watering_suppressed' =>
      ActivityEntry(Icons.pause_circle_outline_rounded, 'Tạm hoãn tưới tự động', reason(data['reason']), warning),
    'water_availability_changed' => switch ('${data['to']}') {
        'empty' => ActivityEntry(Icons.water_damage_rounded, 'Bể nước đã cạn', '', context.colorScheme.error),
        'low' => ActivityEntry(Icons.water_rounded, 'Bể nước sắp hết', '', warning),
        'available' => ActivityEntry(Icons.water_rounded, 'Bể nước đã đủ', '', primary),
        _ => null,
      },
    'button_pressed' => ActivityEntry(Icons.touch_app_rounded, 'Bấm nút tưới tại chỗ', '', primary),
    _ => null,
  };
}
