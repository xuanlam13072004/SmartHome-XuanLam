import 'package:dio/dio.dart';

import 'room_models.dart';

/// Room endpoints. Moving a device between rooms is a device call
/// (`PUT /devices/:mac/room`, see the device repository).
class RoomsApi {
  RoomsApi(this._dio);

  final Dio _dio;

  String _id(String id) => Uri.encodeComponent(id);

  Future<RoomList> fetchRooms() async {
    final response = await _dio.get<Map<String, dynamic>>('/rooms');
    return RoomList.fromJson(response.data!);
  }

  Future<Room> createRoom({required String name, required String icon}) async {
    final response = await _dio.post<Map<String, dynamic>>('/rooms', data: {'name': name, 'icon': icon});
    return Room.fromJson(Map<String, dynamic>.from(response.data!['room'] as Map));
  }

  Future<Room> updateRoom(String id, {String? name, String? icon}) async {
    final response = await _dio.patch<Map<String, dynamic>>('/rooms/${_id(id)}', data: {
      if (name != null) 'name': name,
      if (icon != null) 'icon': icon,
    });
    return Room.fromJson(Map<String, dynamic>.from(response.data!['room'] as Map));
  }

  Future<void> deleteRoom(String id) async {
    await _dio.delete<void>('/rooms/${_id(id)}');
  }

  Future<void> reorder(List<String> roomIds) async {
    await _dio.put<void>('/rooms/order', data: {'room_ids': roomIds});
  }

  /// Creates (or reuses by name) each room and moves its devices in, in one step.
  Future<List<Room>> setup(List<RoomDraft> rooms) async {
    final response = await _dio.post<Map<String, dynamic>>('/rooms/setup', data: {
      'rooms': rooms.map((room) => room.toJson()).toList(),
    });
    return (response.data!['rooms'] as List)
        .map((item) => Room.fromJson(Map<String, dynamic>.from(item as Map)))
        .toList(growable: false);
  }
}
