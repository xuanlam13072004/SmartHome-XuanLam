import 'package:flutter/material.dart';

/// Room icons. The keys are the ones the server accepts (rooms/schemas.ts);
/// the label is shown under the icon and is also the suggested room name.
class RoomIconOption {
  const RoomIconOption(this.key, this.icon, this.label);

  final String key;
  final IconData icon;
  final String label;
}

const roomIconOptions = <RoomIconOption>[
  RoomIconOption('home', Icons.home_rounded, 'Phòng chung'),
  RoomIconOption('living', Icons.weekend_rounded, 'Phòng khách'),
  RoomIconOption('bedroom', Icons.bed_rounded, 'Phòng ngủ'),
  RoomIconOption('kitchen', Icons.kitchen_rounded, 'Bếp'),
  RoomIconOption('entrance', Icons.door_front_door_rounded, 'Lối vào'),
  RoomIconOption('garden', Icons.yard_rounded, 'Sân vườn'),
  RoomIconOption('rooftop', Icons.roofing_rounded, 'Sân thượng'),
  RoomIconOption('garage', Icons.garage_rounded, 'Nhà xe'),
  RoomIconOption('office', Icons.desk_rounded, 'Phòng làm việc'),
  RoomIconOption('bathroom', Icons.bathtub_rounded, 'Phòng tắm'),
  RoomIconOption('kids', Icons.child_care_rounded, 'Phòng trẻ'),
  RoomIconOption('storage', Icons.inventory_2_rounded, 'Nhà kho'),
];

IconData roomIcon(String key) {
  for (final option in roomIconOptions) {
    if (option.key == key) return option.icon;
  }
  return Icons.home_rounded;
}

/// Icon of the "Chưa xếp phòng" group.
const unassignedRoomIcon = Icons.inbox_rounded;
