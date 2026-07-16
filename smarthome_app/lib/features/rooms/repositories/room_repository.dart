import '../models/room_mock.dart';

abstract class IRoomRepository {
  Future<List<RoomMock>> getRooms();
}

class MockRoomRepository implements IRoomRepository {
  @override
  Future<List<RoomMock>> getRooms() async {
    await Future<void>.delayed(const Duration(milliseconds: 500));
    return RoomMock.staticRooms;
  }
}
