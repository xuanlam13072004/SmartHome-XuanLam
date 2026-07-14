import 'package:flutter/material.dart';
import 'package:lucide_icons/lucide_icons.dart';
import '../../../core/widgets/widgets.dart';

class DeviceMock {
  final String id;
  final String title;
  final String subtitle;
  final IconData icon;
  final DeviceStatus status;
  final bool isOn;
  // Giả lập capability cơ bản để test UI
  final double? value;

  const DeviceMock({
    required this.id,
    required this.title,
    required this.subtitle,
    required this.icon,
    required this.status,
    required this.isOn,
    this.value,
  });

  // Một số mock data tĩnh
  static const List<DeviceMock> staticDevices = [
    DeviceMock(
      id: 'd1',
      title: 'Đèn trần',
      subtitle: 'Phòng khách',
      icon: LucideIcons.lightbulb,
      status: DeviceStatus.online,
      isOn: true,
      value: 80.0,
    ),
    DeviceMock(
      id: 'd2',
      title: 'Điều hòa',
      subtitle: 'Phòng ngủ',
      icon: LucideIcons.snowflake,
      status: DeviceStatus.offline,
      isOn: false,
    ),
    DeviceMock(
      id: 'd3',
      title: 'Tivi',
      subtitle: 'Phòng khách',
      icon: LucideIcons.tv,
      status: DeviceStatus.online,
      isOn: false,
    ),
    DeviceMock(
      id: 'd4',
      title: 'Rèm cửa',
      subtitle: 'Phòng ngủ',
      icon: LucideIcons.blinds,
      status: DeviceStatus.online,
      isOn: true,
      value: 50.0,
    ),
    DeviceMock(
      id: 'd5',
      title: 'Khóa cửa',
      subtitle: 'Cửa chính',
      icon: LucideIcons.lock,
      status: DeviceStatus.online,
      isOn: true,
    ),
  ];
}
