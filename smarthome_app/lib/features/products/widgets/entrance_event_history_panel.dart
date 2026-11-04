import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/core.dart';
import '../../../core/widgets/widgets.dart';
import '../../../domain/models/device_event_model.dart';
import '../../dashboard/providers/device_events_provider.dart';

class EntranceEventHistoryPanel extends ConsumerWidget {
  const EntranceEventHistoryPanel({
    super.key,
    required this.deviceMac,
  });

  final String deviceMac;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final events = ref.watch(deviceEventsProvider(deviceMac));
    return NeuCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              const NeuIconBox(
                icon: Icons.history_rounded,
                size: 44,
                iconSize: 22,
                isActive: true,
              ),
              const SizedBox(width: AppSpacing.smMd),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Lịch sử ra vào', style: context.textTheme.titleLarge),
                    const SizedBox(height: AppSpacing.xs),
                    Text(
                      'Hoạt động vật lý gần đây; hệ thống không lưu mã PIN đã nhập.',
                      style: context.textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
              IconButton(
                tooltip: 'Tải lại lịch sử',
                onPressed: () =>
                    ref.invalidate(deviceEventsProvider(deviceMac)),
                icon: const Icon(Icons.refresh_rounded),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.md),
          events.when(
            loading: () => const Padding(
              padding: EdgeInsets.symmetric(vertical: AppSpacing.md),
              child: Center(child: CircularProgressIndicator()),
            ),
            error: (_, __) => _HistoryMessage(
              icon: Icons.lock_person_outlined,
              message:
                  'Không thể tải lịch sử. Chỉ chủ sở hữu thiết bị được phép xem.',
              action: TextButton(
                onPressed: () =>
                    ref.invalidate(deviceEventsProvider(deviceMac)),
                child: const Text('Thử lại'),
              ),
            ),
            data: (items) {
              final visible = items.where(_isMeaningful).take(12).toList();
              if (visible.isEmpty) {
                return const _HistoryMessage(
                  icon: Icons.event_note_outlined,
                  message: 'Chưa có hoạt động mở khóa hoặc đóng/mở cửa.',
                );
              }
              return Column(
                children: [
                  for (var index = 0; index < visible.length; index++) ...[
                    _EntranceEventRow(event: visible[index]),
                    if (index != visible.length - 1)
                      Divider(color: context.colorScheme.outlineVariant),
                  ],
                ],
              );
            },
          ),
        ],
      ),
    );
  }

  static bool _isMeaningful(DeviceEventModel event) {
    if (event.eventName == 'keypad_action') return false;
    if (event.eventName != 'lock_changed') return true;
    final state = '${event.data['state']}';
    return state == 'locked' || state == 'unlocked' || state == 'fault';
  }
}

class _EntranceEventRow extends StatelessWidget {
  const _EntranceEventRow({required this.event});

  final DeviceEventModel event;

  @override
  Widget build(BuildContext context) {
    final presentation = _presentation(context, event);
    return Semantics(
      label: '${presentation.title}. ${presentation.detail}. '
          '${_formatDate(event.occurredAt)}',
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            NeuIconBox(
              icon: presentation.icon,
              size: 40,
              iconSize: 20,
              iconColor: presentation.tone,
              activeIconColor: presentation.tone,
              isActive: true,
            ),
            const SizedBox(width: AppSpacing.smMd),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(presentation.title, style: context.textTheme.titleSmall),
                  if (presentation.detail.isNotEmpty) ...[
                    const SizedBox(height: AppSpacing.xs),
                    Text(presentation.detail,
                        style: context.textTheme.bodySmall),
                  ],
                ],
              ),
            ),
            const SizedBox(width: AppSpacing.sm),
            Text(
              _formatDate(event.occurredAt),
              textAlign: TextAlign.end,
              style: context.textTheme.labelSmall?.copyWith(
                color: context.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _HistoryMessage extends StatelessWidget {
  const _HistoryMessage({
    required this.icon,
    required this.message,
    this.action,
  });

  final IconData icon;
  final String message;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.md),
      child: Column(
        children: [
          Icon(icon, color: context.colorScheme.onSurfaceVariant),
          const SizedBox(height: AppSpacing.sm),
          Text(message,
              textAlign: TextAlign.center, style: context.textTheme.bodySmall),
          if (action != null) action!,
        ],
      ),
    );
  }
}

class _EventPresentation {
  const _EventPresentation(this.icon, this.title, this.detail, this.tone);

  final IconData icon;
  final String title;
  final String detail;
  final Color tone;
}

_EventPresentation _presentation(
  BuildContext context,
  DeviceEventModel event,
) {
  final data = event.data;
  final source = switch ('${data['source']}') {
    'keypad' => 'bàn phím',
    'remote' => 'ứng dụng',
    'automatic' => 'tự động',
    'boot_recovery' => 'khôi phục khi khởi động',
    _ => 'thiết bị',
  };
  return switch (event.eventName) {
    'pin_access_granted' => _EventPresentation(
        Icons.key_rounded,
        'Mã PIN hợp lệ',
        'Thiết bị đã cho phép mở khóa.',
        context.colorScheme.primary,
      ),
    'pin_access_denied' => _EventPresentation(
        Icons.key_off_rounded,
        'Mã PIN không đúng',
        'Còn ${data['attempts_remaining'] ?? 0} lần thử.',
        context.colorScheme.error,
      ),
    'pin_locked_out' => _EventPresentation(
        Icons.lock_clock_rounded,
        'Bàn phím tạm khóa',
        'Thử lại sau ${data['lockout_seconds'] ?? 30} giây.',
        context.colorScheme.error,
      ),
    'door_opened' => _EventPresentation(
        Icons.door_front_door_rounded,
        'Cửa đã mở',
        'Góc đo được ${_angle(data['angle_degrees'])}.',
        context.colorScheme.primary,
      ),
    'door_closed' => _EventPresentation(
        Icons.door_back_door_rounded,
        'Cửa đã đóng',
        'Firmware sẽ tự khóa sau thời gian an toàn.',
        context.colorScheme.primary,
      ),
    'door_position_fault' => _EventPresentation(
        Icons.warning_amber_rounded,
        'Không xác định được vị trí cửa',
        'Cơ chế tự khóa đã dừng để bảo đảm an toàn.',
        context.colorScheme.error,
      ),
    'lock_changed' => _EventPresentation(
        '${data['state']}' == 'locked'
            ? Icons.lock_rounded
            : Icons.lock_open_rounded,
        '${data['state']}' == 'locked' ? 'Cửa đã khóa' : 'Cửa đã mở khóa',
        'Thao tác từ $source.',
        context.colorScheme.primary,
      ),
    _ => _EventPresentation(
        Icons.event_note_rounded,
        'Hoạt động thiết bị',
        event.eventName,
        context.colorScheme.primary,
      ),
  };
}

String _angle(dynamic value) {
  final angle = value is num ? value.toDouble() : double.tryParse('$value');
  return angle == null ? 'chưa xác định' : '${angle.toStringAsFixed(1)}°';
}

String _formatDate(DateTime value) {
  final local = value.toLocal();
  String two(int number) => number.toString().padLeft(2, '0');
  return '${two(local.hour)}:${two(local.minute)}\n'
      '${two(local.day)}/${two(local.month)}';
}
