import 'package:flutter/material.dart';
import 'package:lucide_icons/lucide_icons.dart';
import '../../data/models/dto/device_dto.dart';
import '../models/product_model.dart';
import '../models/device_model.dart';
import '../../features/dashboard/models/capability_model.dart';
import '../../core/widgets/indicators/status_badge.dart' show DeviceStatus;

class CapabilityAssembler {
  static DeviceModel assemble(DeviceDto deviceDto, ProductModel? product) {
    List<CapabilityModel> capabilities = [];
    IconData icon = LucideIcons.box; // Icon mặc định

    if (product != null) {
      // Xác định icon từ category
      if (product.category == 'light' || product.category == 'led') icon = LucideIcons.lightbulb;
      if (product.category == 'ac' || product.category == 'hvac') icon = LucideIcons.wind;
      if (product.category == 'switch' || product.category == 'socket') icon = LucideIcons.toggleLeft;
      if (product.category == 'sensor') icon = LucideIcons.activity;

      // Map state thành capabilities cho UI
      // Đây là nơi logic map cực kì quan trọng (tạm thời mapping thủ công các key phổ biến)
      if (deviceDto.state.containsKey('on_off')) {
        capabilities.add(CapabilityModel(
          id: 'on_off',
          type: 'on_off',
          name: 'Nguồn',
          value: deviceDto.state['on_off'],
        ));
      }
      
      if (deviceDto.state.containsKey('brightness')) {
        capabilities.add(CapabilityModel(
          id: 'brightness',
          type: 'range',
          name: 'Độ sáng',
          value: (deviceDto.state['brightness'] as num).toDouble(),
          properties: {'min': 0, 'max': 100, 'step': 1},
        ));
      }

      if (deviceDto.state.containsKey('temperature')) {
        capabilities.add(CapabilityModel(
          id: 'temperature',
          type: 'sensor',
          name: 'Nhiệt độ',
          value: (deviceDto.state['temperature'] as num).toDouble(),
          properties: {'unit': '°C'},
          isReadOnly: true,
        ));
      }
    }

    return DeviceModel(
      id: deviceDto.mac, // Lưu ý: Backend dùng MAC làm ID cho các endpoint lệnh
      ownerId: deviceDto.ownerId,
      mac: deviceDto.mac,
      name: deviceDto.name,
      productId: deviceDto.productId,
      room: 'Chưa phân phòng', // Backend chưa hỗ trợ Room
      icon: icon,
      status: deviceDto.isOnline ? DeviceStatus.online : DeviceStatus.offline,
      rawState: deviceDto.state,
      diagnostics: deviceDto.diagnostics,
      capabilities: capabilities,
    );
  }
}
