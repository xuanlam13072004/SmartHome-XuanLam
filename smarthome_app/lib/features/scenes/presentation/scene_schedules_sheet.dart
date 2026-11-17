import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/core.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../profile/widgets/confirm_dialog.dart';
import '../data/scene_models.dart';
import '../providers/scenes_providers.dart';
import '../scene_labels.dart';

/// "Hẹn giờ" of one scene: its schedules, each turned on or off in place.
Future<void> showSceneSchedulesSheet(BuildContext context, String sceneId) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    useRootNavigator: true,
    builder: (_) => _SceneSchedulesSheet(sceneId: sceneId),
  );
}

class _SceneSchedulesSheet extends ConsumerStatefulWidget {
  const _SceneSchedulesSheet({required this.sceneId});

  final String sceneId;

  @override
  ConsumerState<_SceneSchedulesSheet> createState() => _SceneSchedulesSheetState();
}

class _SceneSchedulesSheetState extends ConsumerState<_SceneSchedulesSheet> {
  final Set<String> _busy = {};
  String? _error;

  Future<void> _guard(String key, Future<void> Function() work) async {
    setState(() {
      _busy.add(key);
      _error = null;
    });
    try {
      await work();
    } catch (error) {
      if (mounted) setState(() => _error = AppErrorMapper.mapError(error));
    } finally {
      if (mounted) setState(() => _busy.remove(key));
    }
  }

  Future<void> _edit(Scene scene, [SceneSchedule? schedule]) async {
    final result = await showScheduleEditor(context, schedule: schedule);
    if (result == null || !mounted) return;
    final controller = ref.read(scenesProvider.notifier);
    if (result.delete && schedule != null) {
      await _guard(schedule.id, () => controller.removeSchedule(schedule));
    } else if (schedule == null) {
      await _guard('new', () => controller.addSchedule(scene.id, time: result.time, days: result.days));
    } else {
      await _guard(schedule.id, () => controller.editSchedule(schedule, time: result.time, days: result.days));
    }
  }

  @override
  Widget build(BuildContext context) {
    final list = ref.watch(scenesProvider).valueOrNull;
    final scene = list?.byId(widget.sceneId);
    if (scene == null) return const SizedBox(height: 120, child: Center(child: CircularProgressIndicator()));
    final scheme = context.colorScheme;
    final full = scene.schedules.length >= (list?.maxSchedules ?? 5);

    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.8),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
            child: Text('Hẹn giờ · ${scene.name}', style: context.textTheme.titleLarge, maxLines: 2),
          ),
          const SizedBox(height: AppSpacing.xs),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
            child: Text(
              scene.protected
                  ? 'Kịch bản có thao tác cần nhập mật khẩu (như mở khóa cửa) nên không thể chạy tự động theo giờ.'
                  : 'Kịch bản sẽ tự chạy vào giờ đã đặt. Nếu máy chủ không hoạt động quá 15 phút sau giờ hẹn, lần đó được bỏ qua.',
              style: context.textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
            ),
          ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(AppSpacing.lg, AppSpacing.sm, AppSpacing.lg, 0),
              child: Text(_error!, style: TextStyle(color: scheme.error)),
            ),
          Flexible(
            child: ListView(
              shrinkWrap: true,
              padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
              children: [
                for (final schedule in scene.schedules)
                  ListTile(
                    leading: Icon(
                      Icons.schedule_rounded,
                      color: schedule.enabled ? scheme.primary : scheme.onSurfaceVariant,
                    ),
                    title: Text(
                      '${schedule.time} · ${SceneLabels.days(schedule.days)}',
                      style: TextStyle(fontWeight: FontWeight.w700, color: schedule.enabled ? null : scheme.onSurfaceVariant),
                    ),
                    subtitle: Text([
                      if (schedule.enabled && schedule.nextRunAt != null)
                        'Lần tới: ${SceneLabels.nextRun(schedule.nextRunAt!)}'
                      else
                        'Đang tắt',
                      if (SceneLabels.lastResult(schedule.lastResult, schedule.lastFiredAt) case final last?) last,
                    ].join('\n')),
                    isThreeLine: schedule.lastResult != null,
                    onTap: _busy.contains(schedule.id) ? null : () => _edit(scene, schedule),
                    trailing: _busy.contains(schedule.id)
                        ? const SizedBox.square(dimension: 24, child: CircularProgressIndicator(strokeWidth: 2.5))
                        : Switch(
                            value: schedule.enabled,
                            onChanged: (value) => _guard(
                              schedule.id,
                              () => ref.read(scenesProvider.notifier).editSchedule(schedule, enabled: value),
                            ),
                          ),
                  ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(AppSpacing.lg, 0, AppSpacing.lg, AppSpacing.lg),
            child: OutlinedButton.icon(
              onPressed: scene.protected || full || _busy.contains('new') ? null : () => _edit(scene),
              icon: _busy.contains('new')
                  ? const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.add_alarm_rounded),
              label: Text(full ? 'Đã đủ ${list?.maxSchedules ?? 5} lịch' : 'Thêm lịch'),
            ),
          ),
        ],
      ),
    );
  }
}

/// What the schedule editor returns.
class ScheduleChoice {
  const ScheduleChoice({required this.time, required this.days, this.delete = false});

  final String time;
  final List<int> days;
  final bool delete;
}

/// Picks a time and weekdays; for an existing [schedule] also offers Delete.
/// Automations use it with [initialTime], [initialDays] and their own [title].
Future<ScheduleChoice?> showScheduleEditor(
  BuildContext context, {
  SceneSchedule? schedule,
  String? initialTime,
  List<int>? initialDays,
  String? title,
}) {
  return showModalBottomSheet<ScheduleChoice>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    useRootNavigator: true,
    builder: (_) => _ScheduleEditor(
      schedule: schedule,
      initialTime: initialTime,
      initialDays: initialDays,
      title: title,
    ),
  );
}

class _ScheduleEditor extends StatefulWidget {
  const _ScheduleEditor({this.schedule, this.initialTime, this.initialDays, this.title});

  final SceneSchedule? schedule;
  final String? initialTime;
  final List<int>? initialDays;
  final String? title;

  @override
  State<_ScheduleEditor> createState() => _ScheduleEditorState();
}

class _ScheduleEditorState extends State<_ScheduleEditor> {
  late TimeOfDay _time = _parse(widget.schedule?.time ?? widget.initialTime ?? '06:30');
  late Set<int> _days = {...widget.schedule?.days ?? widget.initialDays ?? const [1, 2, 3, 4, 5, 6, 7]};

  static TimeOfDay _parse(String value) {
    final parts = value.split(':');
    return TimeOfDay(hour: int.parse(parts[0]), minute: int.parse(parts[1]));
  }

  String get _timeText => '${_time.hour.toString().padLeft(2, '0')}:${_time.minute.toString().padLeft(2, '0')}';

  Future<void> _pickTime() async {
    final picked = await showTimePicker(
      context: context,
      initialTime: _time,
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(alwaysUse24HourFormat: true),
        child: child!,
      ),
    );
    if (picked != null) setState(() => _time = picked);
  }

  Future<void> _delete() async {
    final confirmed = await confirmAction(
      context,
      title: 'Xóa lịch',
      message: 'Xóa lịch ${widget.schedule!.time} · ${SceneLabels.days(widget.schedule!.days)}?',
      confirmLabel: 'Xóa',
      destructive: true,
    );
    if (confirmed && mounted) {
      Navigator.of(context).pop(ScheduleChoice(time: _timeText, days: _days.toList(), delete: true));
    }
  }

  @override
  Widget build(BuildContext context) {
    const presets = <String, List<int>>{
      'Hằng ngày': [1, 2, 3, 4, 5, 6, 7],
      'Thứ 2–6': [1, 2, 3, 4, 5],
      'Cuối tuần': [6, 7],
    };
    return Padding(
      padding: EdgeInsets.fromLTRB(AppSpacing.lg, 0, AppSpacing.lg, AppSpacing.lg + MediaQuery.viewInsetsOf(context).bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(widget.title ?? (widget.schedule == null ? 'Lịch mới' : 'Sửa lịch'), style: context.textTheme.titleLarge),
          const SizedBox(height: AppSpacing.md),
          Center(
            child: TextButton(
              onPressed: _pickTime,
              child: Text(_timeText, style: context.textTheme.displaySmall?.copyWith(fontWeight: FontWeight.w700)),
            ),
          ),
          const SizedBox(height: AppSpacing.sm),
          Wrap(
            spacing: AppSpacing.sm,
            runSpacing: AppSpacing.sm,
            alignment: WrapAlignment.center,
            children: [
              for (final entry in presets.entries)
                ChoiceChip(
                  label: Text(entry.key),
                  selected: _days.length == entry.value.length && _days.containsAll(entry.value),
                  onSelected: (_) => setState(() => _days = {...entry.value}),
                ),
            ],
          ),
          const SizedBox(height: AppSpacing.md),
          Wrap(
            spacing: AppSpacing.xs,
            runSpacing: AppSpacing.xs,
            alignment: WrapAlignment.center,
            children: [
              for (var day = 1; day <= 7; day++)
                FilterChip(
                  label: Text(SceneLabels.weekdayShort[day - 1]),
                  selected: _days.contains(day),
                  onSelected: (selected) => setState(() => selected ? _days.add(day) : _days.remove(day)),
                ),
            ],
          ),
          const SizedBox(height: AppSpacing.lg),
          FilledButton(
            onPressed: _days.isEmpty
                ? null
                : () => Navigator.of(context).pop(
                      ScheduleChoice(time: _timeText, days: (_days.toList()..sort())),
                    ),
            child: Text(_days.isEmpty ? 'Chọn ít nhất một ngày' : 'Lưu'),
          ),
          if (widget.schedule != null) ...[
            const SizedBox(height: AppSpacing.sm),
            TextButton(
              onPressed: _delete,
              style: TextButton.styleFrom(foregroundColor: context.colorScheme.error),
              child: const Text('Xóa lịch'),
            ),
          ],
        ],
      ),
    );
  }
}
