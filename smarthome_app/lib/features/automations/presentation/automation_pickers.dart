import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/core.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../rooms/providers/rooms_providers.dart';
import '../automation_labels.dart';
import '../data/automation_models.dart';
import '../providers/automations_providers.dart';

/// What can start an automation.
Future<String?> pickTriggerKind(BuildContext context) {
  return showModalBottomSheet<String>(
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
            child: Text('Khi nào chạy?', style: sheetContext.textTheme.titleLarge),
          ),
          const SizedBox(height: AppSpacing.sm),
          for (final (kind, title, subtitle) in const [
            ('state', 'Thiết bị đổi trạng thái', 'Ví dụ: cửa mở, trời mưa, gas vượt mức, mất kết nối'),
            ('event', 'Thiết bị báo sự kiện', 'Ví dụ: bắt đầu sự cố an toàn, nhập sai mã PIN, nhấn nút'),
            ('time', 'Đến giờ', 'Một giờ cố định vào các ngày bạn chọn'),
          ])
            ListTile(
              leading: Icon(AutomationLabels.triggerIcon(kind)),
              title: Text(title),
              subtitle: Text(subtitle),
              onTap: () => Navigator.of(sheetContext).pop(kind),
            ),
          const SizedBox(height: AppSpacing.sm),
        ],
      ),
    ),
  );
}

/// A device state (trigger or condition), then the comparison to make.
Future<StateComparison?> pickStateComparison(BuildContext context, {required bool condition}) async {
  final picked = await showModalBottomSheet<(AutomationDevice, AutomationProperty)>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    useRootNavigator: true,
    builder: (_) => _DevicePicker<(AutomationDevice, AutomationProperty)>(
      title: condition ? 'Điều kiện' : 'Trạng thái thiết bị',
      empty: 'Chưa có thiết bị nào có trạng thái dùng được.',
      entries: (device) => [
        for (final property in condition ? device.conditions : device.triggers)
          _Entry(property.label, property.instanceLabel, (device, property)),
      ],
    ),
  );
  if (picked == null || !context.mounted) return null;
  return editComparison(context, picked.$1, picked.$2);
}

/// An event one of the devices may report.
Future<AutomationTriggerEvent?> pickDeviceEvent(BuildContext context) async {
  final picked = await showModalBottomSheet<(AutomationDevice, AutomationEventOption)>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    useRootNavigator: true,
    builder: (_) => _DevicePicker<(AutomationDevice, AutomationEventOption)>(
      title: 'Sự kiện của thiết bị',
      empty: 'Chưa có thiết bị nào báo sự kiện.',
      entries: (device) => [
        for (final event in device.events)
          _Entry(AutomationLabels.event(event.eventName), event.instanceLabel, (device, event)),
      ],
    ),
  );
  return picked == null ? null : AutomationTriggerEvent.of(picked.$1, picked.$2);
}

/// Changes the comparison of [current] (looked up again in the options).
Future<StateComparison?> reeditComparison(
  BuildContext context,
  WidgetRef ref,
  StateComparison current, {
  required bool condition,
}) async {
  final devices = await ref.read(automationOptionsProvider.future);
  for (final device in devices) {
    if (device.mac != current.mac) continue;
    for (final property in condition ? device.conditions : device.triggers) {
      if (property.property == current.property && context.mounted) {
        return editComparison(context, device, property, operator: current.operator, value: current.value);
      }
    }
  }
  return null;
}

/// Operator and value for [property] of [device].
Future<StateComparison?> editComparison(
  BuildContext context,
  AutomationDevice device,
  AutomationProperty property, {
  String? operator,
  Object? value,
}) {
  return showModalBottomSheet<StateComparison>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    useRootNavigator: true,
    builder: (_) => _ComparisonSheet(device: device, property: property, operator: operator, value: value),
  );
}

class _Entry<T> {
  const _Entry(this.title, this.subtitle, this.value);

  final String title;
  final String subtitle;
  final T value;
}

class _DevicePicker<T> extends ConsumerWidget {
  const _DevicePicker({required this.title, required this.empty, required this.entries});

  final String title;
  final String empty;
  final List<_Entry<T>> Function(AutomationDevice device) entries;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final options = ref.watch(automationOptionsProvider);
    final rooms = ref.watch(roomsProvider).valueOrNull;
    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.8),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(AppSpacing.lg, 0, AppSpacing.lg, AppSpacing.sm),
            child: Text(title, style: context.textTheme.titleLarge),
          ),
          Flexible(
            child: options.when(
              loading: () => const Padding(
                padding: EdgeInsets.all(AppSpacing.xl),
                child: Center(child: CircularProgressIndicator()),
              ),
              error: (error, _) => Padding(
                padding: const EdgeInsets.all(AppSpacing.lg),
                child: Text(AppErrorMapper.mapError(error)),
              ),
              data: (devices) {
                final usable = devices.where((device) => entries(device).isNotEmpty).toList();
                if (usable.isEmpty) {
                  return Padding(padding: const EdgeInsets.all(AppSpacing.lg), child: Text(empty));
                }
                // Grouped by this account's rooms, in the rooms' order; no room last.
                final order = {for (final room in rooms?.rooms ?? const []) room.id: room.position};
                usable.sort((a, b) {
                  final left = order[a.roomId] ?? 1 << 20;
                  final right = order[b.roomId] ?? 1 << 20;
                  return left != right ? left.compareTo(right) : a.name.compareTo(b.name);
                });
                final children = <Widget>[];
                String? group;
                for (final device in usable) {
                  final roomName = rooms?.byId(device.roomId)?.name ?? 'Chưa xếp phòng';
                  if (roomName != group) {
                    group = roomName;
                    children.add(Padding(
                      padding: const EdgeInsets.fromLTRB(AppSpacing.lg, AppSpacing.md, AppSpacing.lg, AppSpacing.xs),
                      child: Text(roomName, style: context.textTheme.labelLarge?.copyWith(
                        color: context.colorScheme.primary,
                        fontWeight: FontWeight.w700,
                      )),
                    ));
                  }
                  final items = entries(device);
                  children.add(ExpansionTile(
                    title: Text(device.name),
                    subtitle: Text('${items.length} lựa chọn'),
                    children: [
                      for (final entry in items)
                        ListTile(
                          contentPadding: const EdgeInsets.only(left: AppSpacing.xl, right: AppSpacing.lg),
                          title: Text(entry.title),
                          subtitle: entry.subtitle.isEmpty ? null : Text(entry.subtitle),
                          onTap: () => Navigator.of(context).pop(entry.value),
                        ),
                    ],
                  ));
                }
                return ListView(
                  shrinkWrap: true,
                  padding: const EdgeInsets.only(bottom: AppSpacing.lg),
                  children: children,
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

class _ComparisonSheet extends StatefulWidget {
  const _ComparisonSheet({required this.device, required this.property, this.operator, this.value});

  final AutomationDevice device;
  final AutomationProperty property;
  final String? operator;
  final Object? value;

  @override
  State<_ComparisonSheet> createState() => _ComparisonSheetState();
}

class _ComparisonSheetState extends State<_ComparisonSheet> {
  late String _operator;
  Object? _value;
  final _number = TextEditingController();
  String? _error;

  AutomationProperty get _property => widget.property;

  @override
  void initState() {
    super.initState();
    _operator = _property.operators.contains(widget.operator) ? widget.operator! : _property.operators.first;
    _value = widget.value;
    if (_property.kind == 'boolean') _value ??= true;
    if (_property.kind == 'enum' && !_property.enumValues.contains(_value)) {
      _value = _property.enumValues.isEmpty ? null : _property.enumValues.first;
    }
    if (_property.kind == 'number' && _value is num) _number.text = '$_value';
  }

  @override
  void dispose() {
    _number.dispose();
    super.dispose();
  }

  void _save() {
    Object? value = _value;
    if (_property.kind == 'number') {
      final number = num.tryParse(_number.text.trim().replaceAll(',', '.'));
      final min = _property.minimum;
      final max = _property.maximum;
      if (number == null || (min != null && number < min) || (max != null && number > max)) {
        setState(() => _error = 'Nhập một số${min != null && max != null ? ' từ $min đến $max' : ''}');
        return;
      }
      value = number;
    }
    if (value == null) return;
    Navigator.of(context).pop(StateComparison.of(widget.device, _property, _operator, value));
  }

  @override
  Widget build(BuildContext context) {
    final unit = AutomationLabels.unit(_property.unit);
    return Padding(
      padding: EdgeInsets.fromLTRB(AppSpacing.lg, 0, AppSpacing.lg, AppSpacing.lg + MediaQuery.viewInsetsOf(context).bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(_property.label, style: context.textTheme.titleLarge),
          Text(
            '${widget.device.name}${_property.instanceLabel.isEmpty ? '' : ' · ${_property.instanceLabel}'}',
            style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
          ),
          const SizedBox(height: AppSpacing.md),
          if (_property.operators.length > 1) ...[
            Wrap(
              spacing: AppSpacing.sm,
              children: [
                for (final operator in _property.operators)
                  ChoiceChip(
                    label: Text(AutomationLabels.operatorLabel(operator, _property.kind)),
                    selected: operator == _operator,
                    onSelected: (_) => setState(() => _operator = operator),
                  ),
              ],
            ),
            const SizedBox(height: AppSpacing.md),
          ],
          if (_property.kind == 'number')
            TextField(
              controller: _number,
              autofocus: true,
              keyboardType: const TextInputType.numberWithOptions(decimal: true, signed: true),
              inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[-0-9.,]'))],
              decoration: InputDecoration(
                labelText: 'Giá trị',
                suffixText: unit.isEmpty ? null : unit,
                helperText: _property.minimum != null && _property.maximum != null
                    ? 'Từ ${_property.minimum} đến ${_property.maximum}'
                    : null,
                errorText: _error,
                border: const OutlineInputBorder(),
              ),
              onSubmitted: (_) => _save(),
            )
          else
            Wrap(
              spacing: AppSpacing.sm,
              runSpacing: AppSpacing.sm,
              children: [
                for (final option in _property.kind == 'boolean' ? const <Object>[true, false] : _property.enumValues)
                  ChoiceChip(
                    label: Text(AutomationLabels.value(_property.name, option)),
                    selected: option == _value,
                    onSelected: (_) => setState(() => _value = option),
                  ),
              ],
            ),
          const SizedBox(height: AppSpacing.lg),
          FilledButton(onPressed: _save, child: const Text('Xong')),
        ],
      ),
    );
  }
}
