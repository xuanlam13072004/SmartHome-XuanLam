import 'package:flutter/material.dart';
import 'package:lucide_icons/lucide_icons.dart';
import '../../../core/widgets/widgets.dart';
import 'capability_model.dart';

class DeviceMock {
  final String id;
  final String name;
  final String room; // Có thể trỏ tới room id
  final IconData icon;
  final DeviceStatus status;
  final List<CapabilityModel> capabilities;

  const DeviceMock({
    required this.id,
    required this.name,
    required this.room,
    required this.icon,
    required this.status,
    required this.capabilities,
  });

  DeviceMock copyWith({
    String? id,
    String? name,
    String? room,
    IconData? icon,
    DeviceStatus? status,
    List<CapabilityModel>? capabilities,
  }) {
    return DeviceMock(
      id: id ?? this.id,
      name: name ?? this.name,
      room: room ?? this.room,
      icon: icon ?? this.icon,
      status: status ?? this.status,
      capabilities: capabilities ?? this.capabilities,
    );
  }

  // Getter tiện ích để check xem device đang hoạt động hay không (cho UI)
  bool get isPrimaryOn {
    final onOffCap = capabilities.firstWhere(
      (c) => c.type == 'on_off',
      orElse: () => const CapabilityModel(id: '', type: '', name: '', value: false),
    );
    return onOffCap.value == true;
  }

  // Dữ liệu mẫu phức tạp
  static const List<DeviceMock> staticDevices = [
    DeviceMock(
      id: 'd1',
      name: 'Đèn trần',
      room: 'Phòng khách',
      icon: LucideIcons.lightbulb,
      status: DeviceStatus.online,
      capabilities: [
        CapabilityModel(
          id: 'c1',
          type: 'on_off',
          name: 'Nguồn',
          value: true,
        ),
        CapabilityModel(
          id: 'c2',
          type: 'range',
          name: 'Độ sáng',
          value: 80.0,
          properties: {'min': 0.0, 'max': 100.0, 'step': 1.0, 'unit': '%'},
        ),
      ],
    ),
    DeviceMock(
      id: 'd2',
      name: 'Điều hòa',
      room: 'Phòng ngủ',
      icon: LucideIcons.snowflake,
      status: DeviceStatus.online,
      capabilities: [
        CapabilityModel(
          id: 'c3',
          type: 'on_off',
          name: 'Nguồn',
          value: true,
        ),
        CapabilityModel(
          id: 'c4',
          type: 'range',
          name: 'Nhiệt độ',
          value: 24.0,
          properties: {'min': 16.0, 'max': 30.0, 'step': 1.0, 'unit': '°C'},
        ),
        CapabilityModel(
          id: 'c5',
          type: 'enum',
          name: 'Chế độ',
          value: 'Làm lạnh',
          properties: {
            'options': ['Tự động', 'Làm lạnh', 'Khô', 'Quạt']
          },
        ),
        CapabilityModel(
          id: 'c6',
          type: 'enum',
          name: 'Tốc độ gió',
          value: 'Trung bình',
          properties: {
            'options': ['Thấp', 'Trung bình', 'Cao', 'Tự động']
          },
        ),
      ],
    ),
    DeviceMock(
      id: 'd3',
      name: 'Cảm biến nhiệt độ',
      room: 'Phòng khách',
      icon: LucideIcons.thermometer,
      status: DeviceStatus.online,
      capabilities: [
        CapabilityModel(
          id: 'c7',
          type: 'sensor',
          name: 'Nhiệt độ hiện tại',
          value: 26.5,
          isReadOnly: true,
          properties: {'unit': '°C'},
        ),
        CapabilityModel(
          id: 'c8',
          type: 'sensor',
          name: 'Độ ẩm',
          value: 55.0,
          isReadOnly: true,
          properties: {'unit': '%'},
        ),
      ],
    ),
    DeviceMock(
      id: 'd4',
      name: 'Khóa cửa',
      room: 'Cửa chính',
      icon: LucideIcons.lock,
      status: DeviceStatus.offline, // Tắt/Mất kết nối
      capabilities: [
        CapabilityModel(
          id: 'c9',
          type: 'on_off',
          name: 'Khóa/Mở khóa',
          value: false, // Mở khóa
        ),
        CapabilityModel(
          id: 'c10',
          type: 'sensor',
          name: 'Tình trạng pin',
          value: 15.0, // Pin yếu, có thể sau này mở rộng capability battery
          isReadOnly: true,
          properties: {'unit': '%'},
        ),
      ],
    ),
  ];
}
