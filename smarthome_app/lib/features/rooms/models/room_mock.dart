import 'package:flutter/material.dart';
import 'package:lucide_icons/lucide_icons.dart';

class RoomMock {
  final String id;
  final String name;
  final IconData icon;
  final int activeDevices;
  final int totalDevices;

  const RoomMock({
    required this.id,
    required this.name,
    required this.icon,
    required this.activeDevices,
    required this.totalDevices,
  });

  static const List<RoomMock> staticRooms = [
    RoomMock(
      id: 'r1',
      name: 'Phòng khách',
      icon: LucideIcons.sofa,
      activeDevices: 3,
      totalDevices: 5,
    ),
    RoomMock(
      id: 'r2',
      name: 'Phòng ngủ Master',
      icon: LucideIcons.bedDouble,
      activeDevices: 1,
      totalDevices: 4,
    ),
    RoomMock(
      id: 'r3',
      name: 'Nhà bếp',
      icon: LucideIcons.utensils,
      activeDevices: 0,
      totalDevices: 3,
    ),
    RoomMock(
      id: 'r4',
      name: 'Phòng tắm',
      icon: LucideIcons.bath,
      activeDevices: 2,
      totalDevices: 2,
    ),
  ];
}
