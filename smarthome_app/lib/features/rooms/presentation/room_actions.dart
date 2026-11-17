import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/utils/app_error_mapper.dart';
import '../../profile/widgets/confirm_dialog.dart';
import '../data/room_models.dart';
import '../providers/rooms_providers.dart';
import 'room_editor_sheet.dart';

/// Opens the editor for a new room, or says the limit is reached.
Future<Room?> createRoom(BuildContext context, WidgetRef ref) async {
  final list = ref.read(roomsProvider).valueOrNull;
  if (list != null && list.isFull) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('Bạn đã có đủ ${list.maxRooms} phòng. Hãy xóa bớt phòng không dùng.')),
    );
    return null;
  }
  return showRoomEditor(context);
}

/// Asks, then deletes [room]. Returns true when it was deleted.
/// [beforeDelete] runs once confirmed (e.g. leave the room's page).
Future<bool> deleteRoom(
  BuildContext context,
  WidgetRef ref,
  Room room, {
  VoidCallback? beforeDelete,
}) async {
  final confirmed = await confirmAction(
    context,
    title: 'Xóa phòng',
    message: 'Xóa "${room.name}"? Thiết bị trong phòng không bị gỡ, chỉ chuyển sang "Chưa xếp phòng".',
    confirmLabel: 'Xóa phòng',
    destructive: true,
  );
  if (!confirmed || !context.mounted) return false;
  final messenger = ScaffoldMessenger.of(context);
  final controller = ref.read(roomsProvider.notifier);
  beforeDelete?.call();
  try {
    await controller.delete(room.id);
    messenger.showSnackBar(SnackBar(content: Text('Đã xóa phòng "${room.name}"')));
    return true;
  } catch (error) {
    messenger.showSnackBar(SnackBar(content: Text(AppErrorMapper.mapError(error))));
    return false;
  }
}
