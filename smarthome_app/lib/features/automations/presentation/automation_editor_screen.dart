import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/config/app_config.dart';
import '../../../core/core.dart';
import '../../../core/navigation/app_routes.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../../core/widgets/widgets.dart';
import '../../profile/widgets/confirm_dialog.dart';
import '../../scenes/data/scene_models.dart';
import '../../scenes/presentation/scene_schedules_sheet.dart' show showScheduleEditor;
import '../../scenes/providers/scenes_providers.dart';
import '../../scenes/scene_icons.dart';
import '../../weather/providers/weather_providers.dart';
import '../automation_labels.dart';
import '../data/automation_models.dart';
import '../providers/automations_providers.dart';
import 'automation_pickers.dart';

/// Creates an automation, or edits [automationId]: Khi → Nếu → Thì.
class AutomationEditorScreen extends ConsumerStatefulWidget {
  const AutomationEditorScreen({super.key, this.automationId});

  final String? automationId;

  @override
  ConsumerState<AutomationEditorScreen> createState() => _AutomationEditorScreenState();
}

class _AutomationEditorScreenState extends ConsumerState<AutomationEditorScreen> {
  final _name = TextEditingController();
  final _message = TextEditingController();
  AutomationTrigger? _trigger;
  final List<StateComparison> _conditions = [];
  String? _windowFrom;
  String? _windowTo;
  String? _sceneId;
  bool _notify = false;
  int _cooldown = 300;
  bool _enabled = true;
  bool _loaded = false;
  bool _dirty = false;
  bool _saving = false;
  String? _error;

  bool get _editing => widget.automationId != null;

  @override
  void dispose() {
    _name.dispose();
    _message.dispose();
    super.dispose();
  }

  void _load(Automation automation) {
    _loaded = true;
    _name.text = automation.name;
    _trigger = automation.trigger;
    _conditions
      ..clear()
      ..addAll(automation.conditions);
    _windowFrom = automation.windowFrom;
    _windowTo = automation.windowTo;
    _sceneId = automation.sceneId;
    _notify = automation.notifyMessage != null;
    _message.text = automation.notifyMessage ?? '';
    _cooldown = automation.cooldownSeconds;
    _enabled = automation.enabled;
  }

  void _changed(VoidCallback change) => setState(() {
        change();
        _dirty = true;
        _error = null;
      });

  void _setTrigger(AutomationTrigger trigger) => _changed(() {
        _trigger = trigger;
        // A starting point the user can change.
        if (_name.text.trim().isEmpty) _name.text = _clip(AutomationLabels.trigger(trigger), 60);
        if (_message.text.trim().isEmpty) _message.text = _clip(AutomationLabels.trigger(trigger), 160);
      });

  static String _clip(String text, int max) => text.length <= max ? text : '${text.substring(0, max - 1)}…';

  Future<void> _pickTrigger() async {
    final kind = await pickTriggerKind(context);
    if (kind == null || !mounted) return;
    await _chooseTrigger(kind);
  }

  Future<void> _chooseTrigger(String kind, {AutomationTrigger? current}) async {
    switch (kind) {
      case 'state':
        final state = current?.state != null
            ? await reeditComparison(context, ref, current!.state!, condition: false)
            : await pickStateComparison(context, condition: false);
        if (state != null) _setTrigger(AutomationTrigger.state(state));
      case 'event':
        final event = await pickDeviceEvent(context);
        if (event != null) _setTrigger(AutomationTrigger.event(event));
      default:
        final choice = await showScheduleEditor(
          context,
          title: 'Chạy lúc',
          initialTime: current?.time ?? '23:00',
          initialDays: current?.days,
        );
        if (choice != null) _setTrigger(AutomationTrigger.time(choice.time, choice.days));
    }
  }

  Future<void> _addCondition(int max) async {
    if (_conditions.length >= max) {
      setState(() => _error = 'Tối đa $max điều kiện');
      return;
    }
    final condition = await pickStateComparison(context, condition: true);
    if (condition != null) _changed(() => _conditions.add(condition));
  }

  Future<void> _editCondition(int index) async {
    final condition = await reeditComparison(context, ref, _conditions[index], condition: true);
    if (condition != null) _changed(() => _conditions[index] = condition);
  }

  Future<String?> _pickClock(String initial) async {
    final parts = initial.split(':');
    final picked = await showTimePicker(
      context: context,
      initialTime: TimeOfDay(hour: int.parse(parts[0]), minute: int.parse(parts[1])),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(alwaysUse24HourFormat: true),
        child: child!,
      ),
    );
    if (picked == null) return null;
    return '${picked.hour.toString().padLeft(2, '0')}:${picked.minute.toString().padLeft(2, '0')}';
  }

  Future<void> _pickScene(List<Scene> scenes) async {
    const none = '';
    final picked = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      useRootNavigator: true,
      builder: (sheetContext) => ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(sheetContext).height * 0.7),
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.only(bottom: AppSpacing.lg),
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
              child: Text('Chạy kịch bản', style: sheetContext.textTheme.titleLarge),
            ),
            ListTile(
              leading: const Icon(Icons.block_rounded),
              title: const Text('Không chạy kịch bản'),
              trailing: _sceneId == null ? const Icon(Icons.check_rounded) : null,
              onTap: () => Navigator.of(sheetContext).pop(none),
            ),
            for (final scene in scenes)
              ListTile(
                enabled: !scene.protected && scene.steps.isNotEmpty,
                leading: Icon(sceneIcon(scene.icon)),
                title: Text(scene.name),
                subtitle: Text(scene.protected
                    ? 'Có thao tác cần mật khẩu nên không chạy tự động được'
                    : '${scene.steps.length} bước'),
                trailing: scene.id == _sceneId ? const Icon(Icons.check_rounded) : null,
                onTap: () => Navigator.of(sheetContext).pop(scene.id),
              ),
          ],
        ),
      ),
    );
    if (picked != null) _changed(() => _sceneId = picked == none ? null : picked);
  }

  Future<void> _save() async {
    final name = _name.text.trim().replaceAll(RegExp(r'\s+'), ' ');
    final message = _message.text.trim().replaceAll(RegExp(r'\s+'), ' ');
    final trigger = _trigger;
    final error = name.isEmpty
        ? 'Vui lòng đặt tên'
        : trigger == null
            ? 'Chọn điều kiện kích hoạt (Khi)'
            : _sceneId == null && !_notify
                ? 'Chọn kịch bản để chạy hoặc bật gửi thông báo'
                : _notify && message.isEmpty
                    ? 'Nhập nội dung thông báo'
                    : null;
    if (error != null) {
      setState(() => _error = error);
      return;
    }
    final draft = AutomationDraft(
      name: name,
      enabled: _enabled,
      trigger: trigger!,
      conditions: List.of(_conditions),
      timezone: AppConfig.timeZone,
      cooldownSeconds: _cooldown,
      windowFrom: _windowFrom,
      windowTo: _windowTo,
      sceneId: _sceneId,
      notifyMessage: _notify ? message : null,
    );
    setState(() {
      _saving = true;
      _error = null;
    });
    final controller = ref.read(automationsProvider.notifier);
    final messenger = ScaffoldMessenger.of(context);
    try {
      if (_editing) {
        await controller.replace(widget.automationId!, draft);
      } else {
        await controller.create(draft);
      }
      if (!mounted) return;
      _dirty = false;
      Navigator.of(context).pop();
      messenger.showSnackBar(SnackBar(content: Text(_editing ? 'Đã lưu "$name"' : 'Đã tạo "$name"')));
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = AppErrorMapper.mapError(error);
      });
    }
  }

  Future<void> _delete() async {
    final confirmed = await confirmAction(
      context,
      title: 'Xóa tự động hóa',
      message: 'Xóa "${_name.text.trim()}"? Kịch bản nó chạy vẫn được giữ.',
      confirmLabel: 'Xóa',
      destructive: true,
    );
    if (!confirmed || !mounted) return;
    setState(() => _saving = true);
    try {
      await ref.read(automationsProvider.notifier).delete(widget.automationId!);
      if (!mounted) return;
      _dirty = false;
      Navigator.of(context).pop();
    } catch (error) {
      if (mounted) {
        setState(() {
          _saving = false;
          _error = AppErrorMapper.mapError(error);
        });
      }
    }
  }

  Future<void> _confirmLeave() async {
    final leave = await confirmAction(
      context,
      title: 'Bỏ thay đổi?',
      message: 'Những gì bạn vừa sửa sẽ không được lưu.',
      confirmLabel: 'Bỏ thay đổi',
      destructive: true,
    );
    if (leave && mounted) {
      _dirty = false;
      Navigator.of(context).pop();
    }
  }

  @override
  Widget build(BuildContext context) {
    final list = ref.watch(automationsProvider).valueOrNull;
    // Loaded early for the pickers.
    ref.watch(automationOptionsProvider);
    final home = ref.watch(homeWeatherProvider).valueOrNull;
    final needsHome = home != null && home.enabled && home.location == null;
    final scenes = ref.watch(scenesProvider).valueOrNull?.scenes ?? const <Scene>[];
    final automation = list?.byId(widget.automationId);
    if (_editing && !_loaded && automation != null) _load(automation);
    final maxConditions = list?.maxConditions ?? 3;
    final scheme = context.colorScheme;

    if (_editing && !_loaded) {
      return PageScaffold(
        scrollable: false,
        appBar: AppBar(title: const Text('Sửa tự động hóa')),
        child: list == null
            ? const Center(child: CircularProgressIndicator())
            : const Center(
                child: EmptyState(
                  icon: Icons.auto_mode_rounded,
                  title: 'Không tìm thấy tự động hóa',
                  description: 'Tự động hóa này không còn tồn tại.',
                ),
              ),
      );
    }

    Scene? scene;
    for (final item in scenes) {
      if (item.id == _sceneId) scene = item;
    }
    final trigger = _trigger;
    final isTime = trigger?.kind == 'time';

    return PopScope(
      canPop: !_dirty,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _confirmLeave();
      },
      child: Scaffold(
        appBar: AppBar(
          title: Text(_editing ? 'Sửa tự động hóa' : 'Tự động hóa mới'),
          actions: [
            TextButton(
              onPressed: _saving ? null : _save,
              child: _saving
                  ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Text('Lưu'),
            ),
          ],
        ),
        body: ListView(
          padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.md, AppSpacing.md, 120),
          children: [
            TextField(
              controller: _name,
              enabled: !_saving,
              maxLength: 60,
              textCapitalization: TextCapitalization.sentences,
              decoration: const InputDecoration(
                labelText: 'Tên',
                hintText: 'VD: Cửa mở lúc đêm',
                border: OutlineInputBorder(),
              ),
              onChanged: (_) => _changed(() {}),
            ),
            if (_error != null) ...[
              Text(_error!, style: TextStyle(color: scheme.error, fontWeight: FontWeight.w600)),
              const SizedBox(height: AppSpacing.sm),
            ],
            _Section(
              title: 'Khi',
              subtitle: 'Điều gì làm tự động hóa chạy',
              children: [
                if (trigger == null)
                  ListTile(
                    leading: const Icon(Icons.add_circle_outline_rounded),
                    title: const Text('Chọn điều kiện kích hoạt'),
                    onTap: _saving ? null : _pickTrigger,
                  )
                else
                  ListTile(
                    leading: Icon(AutomationLabels.triggerIcon(trigger.kind),
                        color: trigger.available ? scheme.primary : scheme.error),
                    title: Text(AutomationLabels.trigger(trigger)),
                    subtitle: Text(switch (trigger.kind) {
                      'state' => trigger.available
                          ? 'Chạy khi trạng thái chuyển sang đúng như vậy'
                          : 'Thiết bị hoặc trạng thái không còn dùng được',
                      'event' => trigger.available ? 'Chạy mỗi lần thiết bị báo' : 'Thiết bị không còn dùng được',
                      _ => 'Nếu máy chủ không hoạt động quá 15 phút sau giờ này, lần đó được bỏ qua',
                    }),
                    trailing: IconButton(
                      tooltip: 'Đổi loại',
                      icon: const Icon(Icons.swap_horiz_rounded),
                      onPressed: _saving ? null : _pickTrigger,
                    ),
                    onTap: _saving ? null : () => _chooseTrigger(trigger.kind, current: trigger),
                  ),
              ],
            ),
            _Section(
              title: 'Nếu',
              subtitle: 'Không bắt buộc. Mọi điều kiện phải đúng ở thời điểm đó.',
              children: [
                for (var index = 0; index < _conditions.length; index++)
                  ListTile(
                    leading: Icon(Icons.rule_rounded,
                        color: _conditions[index].available ? null : scheme.error),
                    title: Text('${_conditions[index].deviceName}: ${AutomationLabels.comparison(_conditions[index])}'),
                    subtitle: _conditions[index].available
                        ? null
                        : Text(_conditions[index].isWeather ? 'Chưa đặt vị trí nhà' : 'Thiết bị không còn dùng được'),
                    onTap: _saving ? null : () => _editCondition(index),
                    trailing: IconButton(
                      tooltip: 'Bỏ điều kiện',
                      icon: const Icon(Icons.close_rounded),
                      onPressed: _saving ? null : () => _changed(() => _conditions.removeAt(index)),
                    ),
                  ),
                if (_conditions.length < maxConditions)
                  ListTile(
                    leading: const Icon(Icons.add_rounded),
                    title: const Text('Thêm điều kiện'),
                    subtitle: needsHome ? null : const Text('Trạng thái thiết bị hoặc thời tiết ở nhà'),
                    onTap: _saving ? null : () => _addCondition(maxConditions),
                  ),
                if (needsHome)
                  ListTile(
                    leading: const Icon(Icons.cloud_outlined),
                    title: const Text('Dùng thời tiết làm điều kiện'),
                    subtitle: const Text('Đặt vị trí nhà để thêm "nếu không mưa", "nếu trên 35°C"…'),
                    trailing: const Icon(Icons.chevron_right_rounded),
                    onTap: _saving ? null : () => context.push(AppRoutes.profileHomeLocation),
                  ),
                SwitchListTile(
                  secondary: const Icon(Icons.nightlight_round),
                  title: const Text('Chỉ trong khung giờ'),
                  subtitle: _windowFrom == null
                      ? const Text('Luôn hoạt động')
                      : Text(AutomationLabels.window(_windowFrom!, _windowTo!)),
                  value: _windowFrom != null,
                  onChanged: _saving
                      ? null
                      : (on) => _changed(() {
                            _windowFrom = on ? '22:00' : null;
                            _windowTo = on ? '06:00' : null;
                          }),
                ),
                if (_windowFrom != null)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, AppSpacing.sm),
                    child: Row(
                      children: [
                        Expanded(
                          child: OutlinedButton(
                            onPressed: () async {
                              final value = await _pickClock(_windowFrom!);
                              if (value != null && value != _windowTo) _changed(() => _windowFrom = value);
                            },
                            child: Text('Từ $_windowFrom'),
                          ),
                        ),
                        const SizedBox(width: AppSpacing.sm),
                        Expanded(
                          child: OutlinedButton(
                            onPressed: () async {
                              final value = await _pickClock(_windowTo!);
                              if (value != null && value != _windowFrom) _changed(() => _windowTo = value);
                            },
                            child: Text('Đến $_windowTo'),
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
            _Section(
              title: 'Thì',
              subtitle: 'Chạy một kịch bản, gửi thông báo, hoặc cả hai',
              children: [
                ListTile(
                  leading: Icon(scene == null ? Icons.play_circle_outline_rounded : sceneIcon(scene.icon)),
                  title: Text(scene?.name ?? (_sceneId == null ? 'Không chạy kịch bản' : 'Kịch bản đã bị xóa')),
                  subtitle: const Text('Kịch bản cần mật khẩu không chạy tự động được'),
                  trailing: const Icon(Icons.chevron_right_rounded),
                  onTap: _saving ? null : () => _pickScene(scenes),
                ),
                SwitchListTile(
                  secondary: const Icon(Icons.notifications_rounded),
                  title: const Text('Gửi thông báo cho tôi'),
                  value: _notify,
                  onChanged: _saving
                      ? null
                      : (on) => _changed(() {
                            _notify = on;
                            if (on && _message.text.trim().isEmpty && _trigger != null) {
                              _message.text = _clip(AutomationLabels.trigger(_trigger!), 160);
                            }
                          }),
                ),
                if (_notify)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, AppSpacing.sm),
                    child: TextField(
                      controller: _message,
                      enabled: !_saving,
                      maxLength: 160,
                      minLines: 1,
                      maxLines: 3,
                      textCapitalization: TextCapitalization.sentences,
                      decoration: const InputDecoration(
                        labelText: 'Nội dung thông báo',
                        border: OutlineInputBorder(),
                      ),
                      onChanged: (_) => _changed(() {}),
                    ),
                  ),
              ],
            ),
            if (!isTime)
              _Section(
                title: 'Không lặp lại trong',
                subtitle: 'Sau mỗi lần chạy, tạm bỏ qua các lần kích hoạt tiếp theo trong khoảng này',
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, AppSpacing.md),
                    child: Wrap(
                      spacing: AppSpacing.sm,
                      children: [
                        for (final seconds in AutomationLabels.cooldowns)
                          ChoiceChip(
                            label: Text(AutomationLabels.cooldown(seconds)),
                            selected: seconds == _cooldown,
                            onSelected: _saving ? null : (_) => _changed(() => _cooldown = seconds),
                          ),
                      ],
                    ),
                  ),
                ],
              ),
            if (_editing) ...[
              const SizedBox(height: AppSpacing.lg),
              TextButton.icon(
                onPressed: _saving ? null : _delete,
                style: TextButton.styleFrom(foregroundColor: scheme.error),
                icon: const Icon(Icons.delete_outline_rounded),
                label: const Text('Xóa tự động hóa'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({required this.title, required this.subtitle, required this.children});

  final String title;
  final String subtitle;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.md),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(title, style: context.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
          Text(
            subtitle,
            style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
          ),
          const SizedBox(height: AppSpacing.sm),
          NeuCard(padding: const EdgeInsets.symmetric(vertical: AppSpacing.xs), child: Column(children: children)),
        ],
      ),
    );
  }
}
