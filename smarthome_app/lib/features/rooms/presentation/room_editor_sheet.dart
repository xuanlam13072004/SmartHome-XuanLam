import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/core.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../data/room_models.dart';
import '../providers/rooms_providers.dart';
import '../room_icons.dart';

/// Creates a room, or edits [room]. Returns the saved room, or null if closed.
Future<Room?> showRoomEditor(BuildContext context, {Room? room}) {
  return showModalBottomSheet<Room>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    useRootNavigator: true,
    builder: (_) => RoomEditorSheet(room: room),
  );
}

class RoomEditorSheet extends ConsumerStatefulWidget {
  const RoomEditorSheet({super.key, this.room});

  final Room? room;

  @override
  ConsumerState<RoomEditorSheet> createState() => _RoomEditorSheetState();
}

class _RoomEditorSheetState extends ConsumerState<RoomEditorSheet> {
  late final TextEditingController _name = TextEditingController(text: widget.room?.name ?? '');
  late String _icon = widget.room?.icon ?? 'home';
  bool _saving = false;
  String? _error;

  bool get _editing => widget.room != null;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  /// Empty, or still the label of an icon: the user has not typed a name.
  bool _isSuggestedName(String text) {
    final name = text.trim();
    return name.isEmpty || roomIconOptions.any((option) => option.label == name);
  }

  void _pickIcon(RoomIconOption option) {
    // The name follows the icon ("Phòng trẻ" for the kids icon) until the user
    // types a name of their own, which is then kept.
    final follow = _isSuggestedName(_name.text);
    setState(() {
      _icon = option.key;
      if (follow) _error = null;
    });
    if (follow) {
      _name.text = option.label;
      _name.selection = TextSelection.collapsed(offset: _name.text.length);
    }
  }

  Future<void> _save() async {
    final name = _name.text.trim().replaceAll(RegExp(r'\s+'), ' ');
    if (name.isEmpty) {
      setState(() => _error = 'Vui lòng nhập tên phòng');
      return;
    }
    final room = widget.room;
    if (room != null && name == room.name && _icon == room.icon) {
      Navigator.of(context).pop(room);
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    final controller = ref.read(roomsProvider.notifier);
    try {
      final saved = room == null
          ? await controller.create(name: name, icon: _icon)
          : await controller.edit(
              room.id,
              name: name == room.name ? null : name,
              icon: _icon == room.icon ? null : _icon,
            );
      if (mounted) Navigator.of(context).pop(saved);
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
    final scheme = context.colorScheme;
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
            Text(_editing ? 'Sửa phòng' : 'Phòng mới', style: context.textTheme.titleLarge),
            const SizedBox(height: AppSpacing.md),
            TextField(
              controller: _name,
              autofocus: !_editing,
              maxLength: 60,
              enabled: !_saving,
              textCapitalization: TextCapitalization.sentences,
              textInputAction: TextInputAction.done,
              decoration: InputDecoration(
                labelText: 'Tên phòng',
                hintText: 'VD: Phòng khách',
                errorText: _error,
                border: const OutlineInputBorder(),
              ),
              onSubmitted: (_) => _save(),
            ),
            const SizedBox(height: AppSpacing.sm),
            Text('Biểu tượng', style: context.textTheme.labelLarge),
            const SizedBox(height: AppSpacing.sm),
            Wrap(
              spacing: AppSpacing.sm,
              runSpacing: AppSpacing.sm,
              children: [
                for (final option in roomIconOptions)
                  _IconChoice(
                    option: option,
                    selected: option.key == _icon,
                    onTap: _saving ? null : () => _pickIcon(option),
                    scheme: scheme,
                  ),
              ],
            ),
            const SizedBox(height: AppSpacing.lg),
            FilledButton(
              onPressed: _saving ? null : _save,
              child: _saving
                  ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                  : Text(_editing ? 'Lưu' : 'Tạo phòng'),
            ),
          ],
        ),
      ),
    );
  }
}

class _IconChoice extends StatelessWidget {
  const _IconChoice({
    required this.option,
    required this.selected,
    required this.onTap,
    required this.scheme,
  });

  final RoomIconOption option;
  final bool selected;
  final VoidCallback? onTap;
  final ColorScheme scheme;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      selected: selected,
      label: option.label,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppRadius.md),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 150),
          width: 80,
          padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
          decoration: BoxDecoration(
            color: selected ? scheme.primary.withValues(alpha: 0.12) : scheme.surfaceContainerHighest.withValues(alpha: 0.4),
            borderRadius: BorderRadius.circular(AppRadius.md),
            border: Border.all(color: selected ? scheme.primary : Colors.transparent, width: 1.5),
          ),
          child: Column(
            children: [
              Icon(option.icon, color: selected ? scheme.primary : scheme.onSurfaceVariant),
              const SizedBox(height: AppSpacing.xs),
              ExcludeSemantics(
                child: Text(
                  option.label,
                  maxLines: 2,
                  textAlign: TextAlign.center,
                  overflow: TextOverflow.ellipsis,
                  style: context.textTheme.labelSmall?.copyWith(
                    color: selected ? scheme.primary : scheme.onSurfaceVariant,
                    fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
