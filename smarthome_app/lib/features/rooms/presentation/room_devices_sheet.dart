import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/core.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../dashboard/providers/devices_provider.dart';
import '../data/room_models.dart';
import '../providers/rooms_providers.dart';

/// Ticks the devices that belong in [room]; unticking takes one out.
Future<void> showRoomDevicesSheet(BuildContext context, Room room) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    useRootNavigator: true,
    builder: (_) => _RoomDevicesSheet(room: room),
  );
}

class _RoomDevicesSheet extends ConsumerStatefulWidget {
  const _RoomDevicesSheet({required this.room});

  final Room room;

  @override
  ConsumerState<_RoomDevicesSheet> createState() => _RoomDevicesSheetState();
}

class _RoomDevicesSheetState extends ConsumerState<_RoomDevicesSheet> {
  late final Set<String> _initial;
  late final Set<String> _selected;
  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    final devices = ref.read(devicesProvider).valueOrNull ?? const [];
    _initial = {for (final device in devices) if (device.roomId == widget.room.id) device.mac};
    _selected = {..._initial};
  }

  Future<void> _save() async {
    final selected = _selected;
    final added = selected.difference(_initial);
    final removed = _initial.difference(selected);
    if (added.isEmpty && removed.isEmpty) {
      Navigator.of(context).pop();
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    final notifier = ref.read(devicesProvider.notifier);
    final messenger = ScaffoldMessenger.of(context);
    var failed = 0;
    Object? lastError;
    // A home has a handful of devices; one small call per changed device.
    for (final mac in added) {
      try {
        await notifier.moveToRoom(mac, widget.room.id);
      } catch (error) {
        failed++;
        lastError = error;
      }
    }
    for (final mac in removed) {
      try {
        await notifier.moveToRoom(mac, null);
      } catch (error) {
        failed++;
        lastError = error;
      }
    }
    if (!mounted) return;
    if (failed == 0) {
      Navigator.of(context).pop();
      messenger.showSnackBar(SnackBar(content: Text('Đã cập nhật thiết bị của ${widget.room.name}')));
    } else {
      setState(() {
        _saving = false;
        _error = '$failed thiết bị chưa chuyển được: ${AppErrorMapper.mapError(lastError)}';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final devices = ref.watch(devicesProvider).valueOrNull ?? const [];
    final rooms = ref.watch(roomsProvider).valueOrNull;
    final selected = _selected;
    final maxHeight = MediaQuery.sizeOf(context).height * 0.75;

    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: maxHeight),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
            child: Text('Thiết bị trong ${widget.room.name}', style: context.textTheme.titleLarge),
          ),
          const SizedBox(height: AppSpacing.xs),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
            child: Text(
              'Mỗi thiết bị chỉ ở một phòng. Chọn thiết bị đang ở phòng khác sẽ chuyển nó sang đây.',
              style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
            ),
          ),
          const SizedBox(height: AppSpacing.sm),
          if (devices.isEmpty)
            const Padding(
              padding: EdgeInsets.all(AppSpacing.lg),
              child: Text('Bạn chưa có thiết bị nào.'),
            )
          else
            Flexible(
              child: ListView(
                shrinkWrap: true,
                children: [
                  for (final device in devices)
                    CheckboxListTile(
                      value: selected.contains(device.mac),
                      onChanged: _saving
                          ? null
                          : (checked) => setState(() {
                                if (checked == true) {
                                  selected.add(device.mac);
                                } else {
                                  selected.remove(device.mac);
                                }
                              }),
                      secondary: Icon(device.icon),
                      title: Text(device.name, maxLines: 1, overflow: TextOverflow.ellipsis),
                      subtitle: Text(
                        device.roomId == widget.room.id
                            ? 'Đang ở phòng này'
                            : rooms?.byId(device.roomId)?.name ?? 'Chưa xếp phòng',
                      ),
                    ),
                ],
              ),
            ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(AppSpacing.lg, AppSpacing.sm, AppSpacing.lg, 0),
              child: Text(_error!, style: TextStyle(color: context.colorScheme.error)),
            ),
          Padding(
            padding: const EdgeInsets.all(AppSpacing.lg),
            child: FilledButton(
              onPressed: _saving || devices.isEmpty ? null : _save,
              child: _saving
                  ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Text('Lưu'),
            ),
          ),
        ],
      ),
    );
  }
}
