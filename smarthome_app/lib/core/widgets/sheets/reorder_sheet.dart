import 'package:flutter/material.dart';

import '../../core.dart';
import '../../utils/app_error_mapper.dart';

/// Drag items into a new order; [onSave] receives their ids in that order.
/// Used for rooms and scenes.
Future<void> showReorderSheet<T>(
  BuildContext context, {
  required String title,
  required List<T> items,
  required String Function(T item) idOf,
  required String Function(T item) labelOf,
  required IconData Function(T item) iconOf,
  required Future<void> Function(List<String> ids) onSave,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    useRootNavigator: true,
    builder: (_) => _ReorderSheet<T>(
      title: title,
      items: items,
      idOf: idOf,
      labelOf: labelOf,
      iconOf: iconOf,
      onSave: onSave,
    ),
  );
}

class _ReorderSheet<T> extends StatefulWidget {
  const _ReorderSheet({
    required this.title,
    required this.items,
    required this.idOf,
    required this.labelOf,
    required this.iconOf,
    required this.onSave,
  });

  final String title;
  final List<T> items;
  final String Function(T item) idOf;
  final String Function(T item) labelOf;
  final IconData Function(T item) iconOf;
  final Future<void> Function(List<String> ids) onSave;

  @override
  State<_ReorderSheet<T>> createState() => _ReorderSheetState<T>();
}

class _ReorderSheetState<T> extends State<_ReorderSheet<T>> {
  late final List<T> _order = [...widget.items];
  bool _saving = false;
  String? _error;

  Future<void> _save() async {
    final ids = _order.map(widget.idOf).toList();
    if (ids.join() == widget.items.map(widget.idOf).join()) {
      Navigator.of(context).pop();
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await widget.onSave(ids);
      if (mounted) Navigator.of(context).pop();
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = AppErrorMapper.mapError(error);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final height = (_order.length * 60.0 + 180).clamp(240.0, MediaQuery.sizeOf(context).height * 0.75);
    return SizedBox(
      height: height,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
            child: Text(widget.title, style: context.textTheme.titleLarge),
          ),
          const SizedBox(height: AppSpacing.sm),
          Expanded(
            child: ReorderableListView.builder(
              buildDefaultDragHandles: false,
              itemCount: _order.length,
              onReorder: (from, to) => setState(() {
                if (to > from) to -= 1;
                _order.insert(to, _order.removeAt(from));
              }),
              itemBuilder: (context, index) {
                final item = _order[index];
                return ListTile(
                  key: ValueKey(widget.idOf(item)),
                  leading: Icon(widget.iconOf(item)),
                  title: Text(widget.labelOf(item)),
                  trailing: ReorderableDragStartListener(
                    index: index,
                    enabled: !_saving,
                    child: const Icon(Icons.drag_indicator_rounded),
                  ),
                );
              },
            ),
          ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
              child: Text(_error!, style: TextStyle(color: context.colorScheme.error)),
            ),
          Padding(
            padding: const EdgeInsets.all(AppSpacing.lg),
            child: FilledButton(
              onPressed: _saving ? null : _save,
              child: _saving
                  ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Text('Lưu thứ tự'),
            ),
          ),
        ],
      ),
    );
  }
}
