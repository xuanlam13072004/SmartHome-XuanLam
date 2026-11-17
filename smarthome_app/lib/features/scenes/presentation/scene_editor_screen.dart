import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/core.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../../core/widgets/widgets.dart';
import '../../profile/widgets/confirm_dialog.dart';
import '../data/scene_models.dart';
import '../providers/scenes_providers.dart';
import '../scene_icons.dart';
import '../scene_labels.dart';
import '../widgets/action_input_sheet.dart';
import 'action_picker_sheet.dart';

/// Creates a scene, or edits [sceneId]: name, icon and ordered steps.
class SceneEditorScreen extends ConsumerStatefulWidget {
  const SceneEditorScreen({super.key, this.sceneId});

  final String? sceneId;

  @override
  ConsumerState<SceneEditorScreen> createState() => _SceneEditorScreenState();
}

/// A step with an id that survives reordering (two identical steps stay apart).
class _Item {
  _Item(this.id, this.step);

  final int id;
  SceneStep step;
}

const _delayOptions = [0, 5, 10, 30, 60, 300, 600, 1800, 3600];

class _SceneEditorScreenState extends ConsumerState<SceneEditorScreen> {
  final _name = TextEditingController();
  String _icon = 'play';
  final List<_Item> _items = [];
  int _nextId = 0;
  bool _loaded = false;
  bool _dirty = false;
  bool _saving = false;
  String? _error;

  bool get _editing => widget.sceneId != null;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  void _load(Scene scene) {
    _loaded = true;
    _name.text = scene.name;
    _icon = scene.icon;
    _items
      ..clear()
      ..addAll(scene.steps.map((step) => _Item(_nextId++, step)));
  }

  void _changed(VoidCallback change) => setState(() {
        change();
        _dirty = true;
        _error = null;
      });

  Future<void> _addStep(int maxSteps) async {
    if (_items.length >= maxSteps) {
      setState(() => _error = 'Một kịch bản có tối đa $maxSteps bước');
      return;
    }
    final step = await pickSceneStep(context);
    if (step != null) _changed(() => _items.add(_Item(_nextId++, step)));
  }

  Future<void> _editInput(_Item item) async {
    final devices = await ref.read(sceneActionsProvider.future);
    SceneAction? action;
    for (final device in devices) {
      if (device.mac != item.step.mac) continue;
      for (final candidate in device.actions) {
        if (candidate.instanceId == item.step.instanceId && candidate.operation == item.step.operation) {
          action = candidate;
        }
      }
    }
    if (!mounted || action == null || action.input.isEmpty) return;
    final values = await showActionInputSheet(context, action, deviceName: item.step.deviceName, initial: item.step.input);
    if (values != null) _changed(() => item.step = item.step.copyWith(input: values));
  }

  Future<void> _pickDelay(_Item item) async {
    final seconds = await showModalBottomSheet<int>(
      context: context,
      showDragHandle: true,
      useRootNavigator: true,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
              child: Text('Chờ trước bước này', style: sheetContext.textTheme.titleLarge),
            ),
            for (final option in _delayOptions)
              ListTile(
                title: Text(option == 0 ? 'Không chờ' : SceneLabels.delay(option)),
                trailing: option == item.step.delaySeconds ? const Icon(Icons.check_rounded) : null,
                onTap: () => Navigator.of(sheetContext).pop(option),
              ),
          ],
        ),
      ),
    );
    if (seconds != null) _changed(() => item.step = item.step.copyWith(delaySeconds: seconds));
  }

  Future<void> _save() async {
    final name = _name.text.trim().replaceAll(RegExp(r'\s+'), ' ');
    if (name.isEmpty) {
      setState(() => _error = 'Vui lòng đặt tên cho kịch bản');
      return;
    }
    if (_items.isEmpty) {
      setState(() => _error = 'Thêm ít nhất một bước');
      return;
    }
    final steps = [
      for (var index = 0; index < _items.length; index++)
        index == 0 ? _items[index].step.copyWith(delaySeconds: 0) : _items[index].step,
    ];
    setState(() {
      _saving = true;
      _error = null;
    });
    final controller = ref.read(scenesProvider.notifier);
    final messenger = ScaffoldMessenger.of(context);
    try {
      if (_editing) {
        await controller.edit(widget.sceneId!, name: name, icon: _icon, steps: steps);
      } else {
        await controller.create(name: name, icon: _icon, steps: steps);
      }
      if (!mounted) return;
      _dirty = false;
      Navigator.of(context).pop();
      messenger.showSnackBar(SnackBar(content: Text(_editing ? 'Đã lưu "$name"' : 'Đã tạo kịch bản "$name"')));
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = AppErrorMapper.mapError(error);
      });
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
    final list = ref.watch(scenesProvider).valueOrNull;
    // Loaded early (and kept) for the step picker and for editing inputs.
    ref.watch(sceneActionsProvider);
    final scene = list?.byId(widget.sceneId);
    if (_editing && !_loaded && scene != null) _load(scene);
    final maxSteps = list?.maxSteps ?? 10;

    if (_editing && !_loaded) {
      return PageScaffold(
        scrollable: false,
        appBar: AppBar(title: const Text('Sửa kịch bản')),
        child: list == null
            ? const Center(child: CircularProgressIndicator())
            : const Center(
                child: EmptyState(
                  icon: Icons.auto_awesome_rounded,
                  title: 'Không tìm thấy kịch bản',
                  description: 'Kịch bản này không còn tồn tại.',
                ),
              ),
      );
    }

    return PopScope(
      canPop: !_dirty,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _confirmLeave();
      },
      child: Scaffold(
        appBar: AppBar(
          title: Text(_editing ? 'Sửa kịch bản' : 'Kịch bản mới'),
          actions: [
            TextButton(
              onPressed: _saving ? null : _save,
              child: _saving
                  ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Text('Lưu'),
            ),
          ],
        ),
        body: ReorderableListView.builder(
          buildDefaultDragHandles: false,
          padding: const EdgeInsets.only(bottom: 120),
          header: _Header(
            name: _name,
            icon: _icon,
            stepCount: _items.length,
            maxSteps: maxSteps,
            error: _error,
            enabled: !_saving,
            onNameChanged: () => _changed(() {}),
            onIcon: (key) => _changed(() => _icon = key),
          ),
          footer: Padding(
            padding: const EdgeInsets.all(AppSpacing.md),
            child: OutlinedButton.icon(
              onPressed: _saving ? null : () => _addStep(maxSteps),
              icon: const Icon(Icons.add_rounded),
              label: const Text('Thêm bước'),
            ),
          ),
          itemCount: _items.length,
          onReorder: (from, to) => _changed(() {
            if (to > from) to -= 1;
            _items.insert(to, _items.removeAt(from));
          }),
          itemBuilder: (context, index) {
            final item = _items[index];
            return _StepTile(
              key: ValueKey(item.id),
              index: index,
              step: item.step,
              enabled: !_saving,
              onTap: () => _editInput(item),
              onDelay: index == 0 ? null : () => _pickDelay(item),
              onRemove: () => _changed(() => _items.remove(item)),
            );
          },
        ),
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({
    required this.name,
    required this.icon,
    required this.stepCount,
    required this.maxSteps,
    required this.error,
    required this.enabled,
    required this.onNameChanged,
    required this.onIcon,
  });

  final TextEditingController name;
  final String icon;
  final int stepCount;
  final int maxSteps;
  final String? error;
  final bool enabled;
  final VoidCallback onNameChanged;
  final ValueChanged<String> onIcon;

  @override
  Widget build(BuildContext context) {
    final scheme = context.colorScheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.md, AppSpacing.md, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          TextField(
            controller: name,
            enabled: enabled,
            maxLength: 60,
            textCapitalization: TextCapitalization.sentences,
            decoration: const InputDecoration(
              labelText: 'Tên kịch bản',
              hintText: 'VD: Ra khỏi nhà',
              border: OutlineInputBorder(),
            ),
            onChanged: (_) => onNameChanged(),
          ),
          Text('Biểu tượng', style: context.textTheme.labelLarge),
          const SizedBox(height: AppSpacing.sm),
          Wrap(
            spacing: AppSpacing.sm,
            runSpacing: AppSpacing.sm,
            children: [
              for (final option in sceneIconOptions)
                Tooltip(
                  message: option.label,
                  child: InkWell(
                    onTap: enabled ? () => onIcon(option.key) : null,
                    borderRadius: BorderRadius.circular(AppRadius.md),
                    child: AnimatedContainer(
                      duration: const Duration(milliseconds: 150),
                      width: 48,
                      height: 48,
                      decoration: BoxDecoration(
                        color: option.key == icon
                            ? scheme.primary.withValues(alpha: 0.12)
                            : scheme.surfaceContainerHighest.withValues(alpha: 0.4),
                        borderRadius: BorderRadius.circular(AppRadius.md),
                        border: Border.all(
                          color: option.key == icon ? scheme.primary : Colors.transparent,
                          width: 1.5,
                        ),
                      ),
                      child: Icon(
                        option.icon,
                        semanticLabel: option.label,
                        color: option.key == icon ? scheme.primary : scheme.onSurfaceVariant,
                      ),
                    ),
                  ),
                ),
            ],
          ),
          const SizedBox(height: AppSpacing.lg),
          Text('Các bước ($stepCount/$maxSteps)', style: context.textTheme.titleMedium),
          const SizedBox(height: AppSpacing.xs),
          Text(
            'Chạy lần lượt từ trên xuống. Kéo để đổi thứ tự; bước hỏng không làm dừng các bước sau.',
            style: context.textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
          ),
          if (error != null) ...[
            const SizedBox(height: AppSpacing.sm),
            Text(error!, style: TextStyle(color: scheme.error, fontWeight: FontWeight.w600)),
          ],
          const SizedBox(height: AppSpacing.sm),
        ],
      ),
    );
  }
}

class _StepTile extends StatelessWidget {
  const _StepTile({
    super.key,
    required this.index,
    required this.step,
    required this.enabled,
    required this.onTap,
    required this.onDelay,
    required this.onRemove,
  });

  final int index;
  final SceneStep step;
  final bool enabled;
  final VoidCallback onTap;
  final VoidCallback? onDelay;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final scheme = context.colorScheme;
    final input = SceneLabels.input(step.input);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.xs),
      child: NeuCard(
        padding: const EdgeInsets.fromLTRB(AppSpacing.sm, AppSpacing.sm, 0, AppSpacing.sm),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (onDelay != null)
              Padding(
                padding: const EdgeInsets.only(left: AppSpacing.xs, bottom: AppSpacing.xs),
                child: ActionChip(
                  visualDensity: VisualDensity.compact,
                  avatar: const Icon(Icons.timer_outlined, size: 16),
                  label: Text(step.delaySeconds == 0 ? 'Không chờ' : SceneLabels.delay(step.delaySeconds)),
                  onPressed: enabled ? onDelay : null,
                ),
              ),
            ListTile(
              contentPadding: const EdgeInsets.only(left: AppSpacing.xs),
              leading: CircleAvatar(
                radius: 14,
                backgroundColor: step.available ? scheme.primary.withValues(alpha: 0.12) : scheme.errorContainer,
                child: Text(
                  '${index + 1}',
                  style: context.textTheme.labelMedium?.copyWith(
                    color: step.available ? scheme.primary : scheme.error,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
              title: Text(step.deviceName, maxLines: 1, overflow: TextOverflow.ellipsis),
              subtitle: Text(
                [
                  input.isEmpty ? step.label : '${step.label} · $input',
                  if (step.protected) 'Cần mật khẩu khi chạy',
                  if (!step.available) 'Thiết bị hoặc quyền không còn, bước này sẽ bị bỏ qua',
                ].join('\n'),
                style: step.available ? null : TextStyle(color: scheme.error),
              ),
              onTap: enabled ? onTap : null,
              trailing: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  IconButton(
                    tooltip: 'Xóa bước',
                    onPressed: enabled ? onRemove : null,
                    icon: const Icon(Icons.delete_outline_rounded),
                  ),
                  ReorderableDragStartListener(
                    index: index,
                    enabled: enabled,
                    child: const Padding(
                      padding: EdgeInsets.symmetric(horizontal: AppSpacing.sm),
                      child: Icon(Icons.drag_indicator_rounded),
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
