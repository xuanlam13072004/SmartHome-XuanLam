import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';
import '../models/room_mock.dart';
import '../repositories/room_repository.dart';
import '../../dashboard/models/device_mock.dart';
import '../../dashboard/providers/devices_provider.dart';

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

/// Tính số lượng thiết bị đang bật trong 1 phòng, dựa vào devicesProvider.
/// Khi Devices thay đổi trạng thái, Provider này sẽ tự tính toán lại.
@riverpod
int activeDevicesInRoom(Ref ref, String roomName) {
  final devicesAsync = ref.watch(devicesProvider);
  return devicesAsync.maybeWhen(
    data: (List<DeviceMock> devices) {
      return devices.where((d) => d.room == roomName && d.isPrimaryOn).length;
    },
    orElse: () => 0,
  );
}
