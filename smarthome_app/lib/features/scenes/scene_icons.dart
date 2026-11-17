import 'package:flutter/material.dart';

/// Scene icons. The keys are the ones the server accepts (scenes/schemas.ts).
class SceneIconOption {
  const SceneIconOption(this.key, this.icon, this.label);

  final String key;
  final IconData icon;
  final String label;
}

const sceneIconOptions = <SceneIconOption>[
  SceneIconOption('play', Icons.play_arrow_rounded, 'Chung'),
  SceneIconOption('leave_home', Icons.directions_walk_rounded, 'Ra khỏi nhà'),
  SceneIconOption('arrive_home', Icons.home_rounded, 'Về nhà'),
  SceneIconOption('sleep', Icons.bedtime_rounded, 'Đi ngủ'),
  SceneIconOption('wake_up', Icons.alarm_rounded, 'Thức dậy'),
  SceneIconOption('water', Icons.water_drop_rounded, 'Tưới cây'),
  SceneIconOption('lock', Icons.lock_rounded, 'Khóa cửa'),
  SceneIconOption('shield', Icons.shield_rounded, 'An ninh'),
  SceneIconOption('sun', Icons.wb_sunny_rounded, 'Buổi sáng'),
  SceneIconOption('moon', Icons.nightlight_rounded, 'Buổi tối'),
  SceneIconOption('rain', Icons.umbrella_rounded, 'Trời mưa'),
  SceneIconOption('party', Icons.celebration_rounded, 'Có khách'),
];

IconData sceneIcon(String key) {
  for (final option in sceneIconOptions) {
    if (option.key == key) return option.icon;
  }
  return Icons.play_arrow_rounded;
}
