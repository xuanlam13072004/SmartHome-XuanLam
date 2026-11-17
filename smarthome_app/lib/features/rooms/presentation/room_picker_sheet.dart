import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/core.dart';
import '../../../core/utils/app_error_mapper.dart';
import '../../../domain/models/device_model.dart';
import '../../dashboard/providers/devices_provider.dart';
import '../providers/rooms_providers.dart';
import '../room_icons.dart';
import 'room_editor_sheet.dart';

/// The answer of [pickRoom]; [roomId] null means "Chưa xếp phòng".
class RoomChoice {
  const RoomChoice(this.roomId);

  final String? roomId;
}

/// Lets the user choose one of their rooms (or none, or a new one).
/// Returns null when the sheet is dismissed.
Future<RoomChoice?> pickRoom(
  BuildContext context, {
  String? currentRoomId,
  String title = 'Chọn phòng',
}) {
  return showModalBottomSheet<RoomChoice>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    useRootNavigator: true,
    builder: (_) => _RoomPickerSheet(currentRoomId: currentRoomId, title: title),
  );
}

/// "Chuyển phòng" for one device: pick, move, and say what happened.
Future<void> moveDeviceToRoom(BuildContext context, WidgetRef ref, DeviceModel device) async {
  final messenger = ScaffoldMessenger.of(context);
  final rooms = ref.read(roomsProvider).valueOrNull;
  final current = rooms?.byId(device.roomId)?.id;
  final choice = await pickRoom(context, currentRoomId: current, title: 'Chuyển "${device.name}" tới');
  if (choice == null || choice.roomId == current) return;
  try {
    await ref.read(devicesProvider.notifier).moveToRoom(device.mac, choice.roomId);
    final name = ref.read(roomsProvider).valueOrNull?.byId(choice.roomId)?.name;
    messenger.showSnackBar(SnackBar(
      content: Text(name == null ? 'Đã đưa "${device.name}" ra khỏi phòng' : 'Đã chuyển "${device.name}" tới $name'),
    ));
  } catch (error) {
    messenger.showSnackBar(SnackBar(content: Text(AppErrorMapper.mapError(error))));
  }
}

class _RoomPickerSheet extends ConsumerWidget {
  const _RoomPickerSheet({required this.currentRoomId, required this.title});

  final String? currentRoomId;
  final String title;

  Future<void> _createRoom(BuildContext context) async {
    final navigator = Navigator.of(context);
    final room = await showRoomEditor(context);
    if (room != null) navigator.pop(RoomChoice(room.id));
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final rooms = ref.watch(roomsProvider);
    final maxHeight = MediaQuery.sizeOf(context).height * 0.7;
    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: maxHeight),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(AppSpacing.lg, 0, AppSpacing.lg, AppSpacing.sm),
            child: Text(title, style: context.textTheme.titleLarge, maxLines: 2, overflow: TextOverflow.ellipsis),
          ),
          Flexible(
            child: rooms.when(
              loading: () => const Padding(
                padding: EdgeInsets.all(AppSpacing.xl),
                child: Center(child: CircularProgressIndicator()),
              ),
              error: (error, _) => Padding(
                padding: const EdgeInsets.all(AppSpacing.lg),
                child: Text(AppErrorMapper.mapError(error)),
              ),
              data: (list) => ListView(
                shrinkWrap: true,
                padding: const EdgeInsets.only(bottom: AppSpacing.lg),
                children: [
                  for (final room in list.rooms)
                    _ChoiceTile(
                      icon: roomIcon(room.icon),
                      label: room.name,
                      selected: room.id == currentRoomId,
                      onTap: () => Navigator.of(context).pop(RoomChoice(room.id)),
                    ),
                  _ChoiceTile(
                    icon: unassignedRoomIcon,
                    label: 'Chưa xếp phòng',
                    selected: currentRoomId == null,
                    onTap: () => Navigator.of(context).pop(const RoomChoice(null)),
                  ),
                  const Divider(height: AppSpacing.md),
                  ListTile(
                    leading: const Icon(Icons.add_rounded),
                    title: const Text('Tạo phòng mới'),
                    subtitle: list.isFull ? Text('Đã đủ ${list.maxRooms} phòng') : null,
                    enabled: !list.isFull,
                    onTap: () => _createRoom(context),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ChoiceTile extends StatelessWidget {
  const _ChoiceTile({
    required this.icon,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = context.colorScheme;
    return ListTile(
      leading: Icon(icon, color: selected ? scheme.primary : scheme.onSurfaceVariant),
      title: Text(
        label,
        style: selected ? TextStyle(color: scheme.primary, fontWeight: FontWeight.w700) : null,
      ),
      trailing: selected ? Icon(Icons.check_rounded, color: scheme.primary) : null,
      selected: selected,
      onTap: onTap,
    );
  }
}
