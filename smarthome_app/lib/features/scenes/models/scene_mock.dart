import 'package:flutter/material.dart';
import 'package:lucide_icons/lucide_icons.dart';

class SceneMock {
  final String id;
  final String name;
  final IconData icon;
  final String description;
  final bool isActive;

  const SceneMock({
    required this.id,
    required this.name,
    required this.icon,
    required this.description,
    this.isActive = false,
  });

  static const List<SceneMock> staticScenes = [
    SceneMock(
      id: 's1',
      name: 'Chào buổi sáng',
      icon: LucideIcons.sunrise,
      description: 'Mở rèm, bật đèn nhẹ và pha cà phê.',
    ),
    SceneMock(
      id: 's2',
      name: 'Ra khỏi nhà',
      icon: LucideIcons.logOut,
      description: 'Tắt toàn bộ thiết bị điện, bật an ninh.',
    ),
    SceneMock(
      id: 's3',
      name: 'Ngủ ngon',
      icon: LucideIcons.moon,
      description: 'Tắt đèn, kéo rèm và điều chỉnh nhiệt độ 26°C.',
      isActive: true, // Đang chạy
    ),
    SceneMock(
      id: 's4',
      name: 'Xem phim',
      icon: LucideIcons.clapperboard,
      description: 'Giảm sáng đèn phòng khách, bật Tivi.',
    ),
  ];
}
