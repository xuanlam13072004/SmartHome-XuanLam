/// One of the account's own rooms. Rooms are personal: a shared device can be
/// in the owner's "Bếp" and in a member's "Nhà bố mẹ" at the same time.
class Room {
  const Room({
    required this.id,
    required this.name,
    required this.icon,
    required this.position,
  });

  final String id;
  final String name;
  final String icon;
  final int position;

  factory Room.fromJson(Map<String, dynamic> json) => Room(
        id: json['id'] as String,
        name: json['name'] as String,
        icon: json['icon'] as String? ?? 'home',
        position: (json['position'] as num?)?.toInt() ?? 0,
      );

  Room copyWith({String? name, String? icon, int? position}) => Room(
        id: id,
        name: name ?? this.name,
        icon: icon ?? this.icon,
        position: position ?? this.position,
      );
}

class RoomList {
  const RoomList({required this.rooms, required this.maxRooms});

  final List<Room> rooms;
  final int maxRooms;

  bool get isFull => rooms.length >= maxRooms;

  Room? byId(String? id) {
    if (id == null) return null;
    for (final room in rooms) {
      if (room.id == id) return room;
    }
    return null;
  }

  RoomList withRooms(List<Room> rooms) => RoomList(rooms: rooms, maxRooms: maxRooms);

  factory RoomList.fromJson(Map<String, dynamic> json) => RoomList(
        rooms: (json['rooms'] as List? ?? const [])
            .map((item) => Room.fromJson(Map<String, dynamic>.from(item as Map)))
            .toList(growable: false),
        maxRooms: ((json['limits'] as Map?)?['max_rooms'] as num?)?.toInt() ?? 30,
      );
}

/// A room to create (or reuse by name) together with the devices to move in.
class RoomDraft {
  const RoomDraft({required this.name, required this.icon, required this.macs});

  final String name;
  final String icon;
  final List<String> macs;

  Map<String, dynamic> toJson() => {'name': name, 'icon': icon, 'devices': macs};
}

/// The same comparison the server's unique index makes (case and spacing).
String roomNameKey(String name) => name.trim().replaceAll(RegExp(r'\s+'), ' ').toLowerCase();
