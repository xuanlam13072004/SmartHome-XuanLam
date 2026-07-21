import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';
import '../models/room_mock.dart';
import '../repositories/room_repository.dart';

part 'rooms_provider.g.dart';

@riverpod
IRoomRepository roomRepository(Ref ref) {
  return MockRoomRepository();
}

@riverpod
class Rooms extends _$Rooms {
  @override
  FutureOr<List<RoomMock>> build() async {
    return ref.read(roomRepositoryProvider).getRooms();
  }
}

// Note: activeDevicesInRoom provider has been removed.
// Backend does not support room assignment for devices.
// When backend adds room support, this provider should be re-added
// using the actual room_id field from the device data model.
