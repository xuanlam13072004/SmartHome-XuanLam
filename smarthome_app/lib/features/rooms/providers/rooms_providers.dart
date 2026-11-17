import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/dio_provider.dart';
import '../../dashboard/providers/devices_provider.dart';
import '../data/room_models.dart';
import '../data/rooms_api.dart';

final roomsApiProvider = Provider.autoDispose<RoomsApi>(
  (ref) => RoomsApi(ref.watch(dioProvider)),
);

/// The account's rooms in display order. Rooms change only through this
/// account's own edits, so the list is updated in place after each call
/// instead of being reloaded; device counts come from the device list.
final roomsProvider = AsyncNotifierProvider.autoDispose<RoomsController, RoomList>(RoomsController.new);

class RoomsController extends AutoDisposeAsyncNotifier<RoomList> {
  @override
  Future<RoomList> build() => ref.watch(roomsApiProvider).fetchRooms();

  RoomsApi get _api => ref.read(roomsApiProvider);

  void _change(List<Room> Function(List<Room> rooms) update) {
    final current = state.valueOrNull;
    if (current != null) state = AsyncData(current.withRooms(update(current.rooms)));
  }

  Future<Room> create({required String name, required String icon}) async {
    final room = await _api.createRoom(name: name, icon: icon);
    _change((rooms) => [...rooms, room]);
    return room;
  }

  Future<Room> edit(String id, {String? name, String? icon}) async {
    final room = await _api.updateRoom(id, name: name, icon: icon);
    _change((rooms) => [for (final item in rooms) item.id == id ? room : item]);
    return room;
  }

  /// Devices of a deleted room become "Chưa xếp phòng"; none is removed.
  Future<void> delete(String id) async {
    await _api.deleteRoom(id);
    _change((rooms) => rooms.where((room) => room.id != id).toList());
    ref.read(devicesProvider.notifier).forgetRoom(id);
  }

  Future<void> reorder(List<String> roomIds) async {
    final before = state.valueOrNull;
    if (before == null) return;
    final byId = {for (final room in before.rooms) room.id: room};
    state = AsyncData(before.withRooms([
      for (var index = 0; index < roomIds.length; index++)
        if (byId[roomIds[index]] != null) byId[roomIds[index]]!.copyWith(position: index),
    ]));
    try {
      await _api.reorder(roomIds);
    } catch (_) {
      state = AsyncData(before);
      rethrow;
    }
  }

  /// Applies suggested rooms in one step and moves the devices locally too.
  Future<void> setup(List<RoomDraft> drafts) async {
    final rooms = await _api.setup(drafts);
    final current = state.valueOrNull;
    state = AsyncData(RoomList(rooms: rooms, maxRooms: current?.maxRooms ?? 30));
    final idByName = {for (final room in rooms) roomNameKey(room.name): room.id};
    ref.read(devicesProvider.notifier).applyRooms({
      for (final draft in drafts)
        if (idByName[roomNameKey(draft.name)] != null)
          for (final mac in draft.macs) mac: idByName[roomNameKey(draft.name)]!,
    });
  }
}
