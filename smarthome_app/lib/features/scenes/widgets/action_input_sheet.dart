import 'package:flutter/material.dart';

import '../../../core/core.dart';
import '../../products/widgets/product_page_kit.dart' show productDurationLabel;
import '../data/scene_models.dart';
import '../scene_labels.dart';

/// Fills an operation's inputs from its catalog schema. Returns the values,
/// or null when closed. Operations without inputs never open it.
Future<Map<String, dynamic>?> showActionInputSheet(
  BuildContext context,
  SceneAction action, {
  String? deviceName,
  Map<String, dynamic>? initial,
}) {
  return showModalBottomSheet<Map<String, dynamic>>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    useRootNavigator: true,
    builder: (_) => _ActionInputSheet(action: action, deviceName: deviceName, initial: initial),
  );
}

const _durationPresets = [30, 60, 120, 300, 600, 900, 1800, 3600];

class _ActionInputSheet extends StatefulWidget {
  const _ActionInputSheet({required this.action, this.deviceName, this.initial});

  final SceneAction action;
  final String? deviceName;
  final Map<String, dynamic>? initial;

  @override
  State<_ActionInputSheet> createState() => _ActionInputSheetState();
}

class _ActionInputSheetState extends State<_ActionInputSheet> {
  late final Map<String, dynamic> _values = {
    for (final entry in widget.action.input.entries)
      entry.key: widget.initial?[entry.key] ?? _defaultFor(Map<String, dynamic>.from(entry.value as Map)),
  };
  final Map<String, List<TextEditingController>> _text = {};
  String? _error;

  Map<String, dynamic> _schema(String name) => Map<String, dynamic>.from(widget.action.input[name] as Map);

  static dynamic _defaultFor(Map<String, dynamic> schema) {
    if (schema.containsKey('default')) return schema['default'];
    final options = schema['enum'];
    if (options is List && options.isNotEmpty) return options.first;
    switch (schema['type']) {
      case 'integer':
      case 'number':
        final minimum = schema['minimum'];
        if (schema['unit'] == 'second' && minimum is num) {
          return _durationPresets.firstWhere((value) => value >= minimum, orElse: () => minimum.toInt());
        }
        return minimum;
      case 'boolean':
        return false;
      case 'array':
        final count = (schema['min_items'] as num?)?.toInt() ?? 0;
        return List<String>.filled(count, '');
      default:
        return '';
    }
  }

  @override
  void dispose() {
    for (final controllers in _text.values) {
      for (final controller in controllers) {
        controller.dispose();
      }
    }
    super.dispose();
  }

  List<TextEditingController> _controllers(String name, List<String> values) =>
      _text.putIfAbsent(name, () => [for (final value in values) TextEditingController(text: value)]);

  void _done() {
    final result = <String, dynamic>{};
    for (final name in widget.action.input.keys) {
      final schema = _schema(name);
      dynamic value = _values[name];
      if (_text.containsKey(name)) {
        final texts = _text[name]!.map((controller) => controller.text).toList();
        value = schema['type'] == 'array' ? texts : texts.first;
      }
      final minimum = schema['minimum'];
      final maximum = schema['maximum'];
      if (value is num && ((minimum is num && value < minimum) || (maximum is num && value > maximum))) {
        setState(() => _error = '${SceneLabels.field(name)} phải trong khoảng $minimum–$maximum');
        return;
      }
      if (value == null && schema['required'] != false) {
        setState(() => _error = 'Vui lòng chọn ${SceneLabels.field(name).toLowerCase()}');
        return;
      }
      if (value != null) result[name] = value;
    }
    Navigator.of(context).pop(result);
  }

  String _optionLabel(Map<String, dynamic> schema, Object? value) =>
      schema['unit'] == 'second' && value is num ? productDurationLabel(value.toInt()) : SceneLabels.value(value);

  Widget _field(String name) {
    final schema = _schema(name);
    final options = schema['enum'];
    final type = schema['type'];

    if (options is List) {
      return _Choices(
        values: options,
        selected: _values[name],
        labelOf: (value) => _optionLabel(schema, value),
        onSelected: (value) => setState(() => _values[name] = value),
      );
    }
    if ((type == 'integer' || type == 'number') && schema['unit'] == 'second') {
      final minimum = (schema['minimum'] as num?) ?? 0;
      final maximum = (schema['maximum'] as num?) ?? 86400;
      final presets = {
        ..._durationPresets.where((value) => value >= minimum && value <= maximum),
        if (_values[name] is num) (_values[name] as num).toInt(),
      }.toList()
        ..sort();
      return _Choices(
        values: presets,
        selected: _values[name],
        labelOf: (value) => _optionLabel(schema, value),
        onSelected: (value) => setState(() => _values[name] = value),
      );
    }
    if (type == 'integer' || type == 'number') {
      final controller = _controllers(name, ['${_values[name] ?? ''}']).first;
      return TextField(
        controller: controller,
        keyboardType: TextInputType.number,
        decoration: InputDecoration(
          border: const OutlineInputBorder(),
          helperText: '${schema['minimum'] ?? ''}–${schema['maximum'] ?? ''}',
        ),
        onChanged: (text) => _values[name] = type == 'integer' ? int.tryParse(text) : num.tryParse(text),
      );
    }
    if (type == 'boolean') {
      return SwitchListTile(
        contentPadding: EdgeInsets.zero,
        title: Text(SceneLabels.field(name)),
        value: _values[name] == true,
        onChanged: (value) => setState(() => _values[name] = value),
      );
    }
    if (type == 'array') {
      final items = Map<String, dynamic>.from(schema['items'] as Map? ?? const {});
      final values = List<String>.from((_values[name] as List?)?.map((value) => '$value') ?? const <String>[]);
      final controllers = _controllers(name, values);
      return Column(
        children: [
          for (var index = 0; index < controllers.length; index++)
            Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.xs),
              child: TextField(
                controller: controllers[index],
                maxLength: (items['max_length'] as num?)?.toInt(),
                decoration: InputDecoration(
                  labelText: 'Dòng ${index + 1}',
                  border: const OutlineInputBorder(),
                  isDense: true,
                ),
              ),
            ),
        ],
      );
    }
    final controller = _controllers(name, ['${_values[name] ?? ''}']).first;
    return TextField(
      controller: controller,
      maxLength: (schema['max_length'] as num?)?.toInt(),
      decoration: const InputDecoration(border: OutlineInputBorder()),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(
        AppSpacing.lg,
        0,
        AppSpacing.lg,
        AppSpacing.lg + MediaQuery.viewInsetsOf(context).bottom,
      ),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(widget.action.label, style: context.textTheme.titleLarge),
            if (widget.deviceName != null)
              Text(
                widget.deviceName!,
                style: context.textTheme.bodyMedium?.copyWith(color: context.colorScheme.onSurfaceVariant),
              ),
            const SizedBox(height: AppSpacing.md),
            for (final name in widget.action.input.keys) ...[
              if (_schema(name)['type'] != 'boolean')
                Padding(
                  padding: const EdgeInsets.only(bottom: AppSpacing.sm),
                  child: Text(SceneLabels.field(name), style: context.textTheme.labelLarge),
                ),
              _field(name),
              const SizedBox(height: AppSpacing.md),
            ],
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(bottom: AppSpacing.sm),
                child: Text(_error!, style: TextStyle(color: context.colorScheme.error)),
              ),
            FilledButton(onPressed: _done, child: const Text('Xong')),
          ],
        ),
      ),
    );
  }
}

class _Choices extends StatelessWidget {
  const _Choices({
    required this.values,
    required this.selected,
    required this.labelOf,
    required this.onSelected,
  });

  final List<dynamic> values;
  final Object? selected;
  final String Function(Object? value) labelOf;
  final ValueChanged<Object?> onSelected;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: AppSpacing.sm,
      runSpacing: AppSpacing.sm,
      children: [
        for (final value in values)
          ChoiceChip(
            label: Text(labelOf(value)),
            selected: value == selected,
            onSelected: (_) => onSelected(value),
          ),
      ],
    );
  }
}
