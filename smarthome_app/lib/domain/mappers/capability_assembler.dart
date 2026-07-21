import 'package:flutter/material.dart';
import 'package:lucide_icons/lucide_icons.dart';
import '../../data/models/dto/device_dto.dart';
import '../models/product_model.dart';
import '../models/device_model.dart';
import '../../features/dashboard/models/capability_model.dart';
import '../../core/widgets/indicators/status_badge.dart' show DeviceStatus;

/// Assembles a DeviceModel from a DeviceDto + ProductModel.
/// All capability mapping is driven by the Product Catalog — no hardcoding.
class CapabilityAssembler {
  static DeviceModel assemble(DeviceDto deviceDto, ProductModel? product) {
    List<CapabilityModel> capabilities = [];
    IconData icon = LucideIcons.box; // Default icon

    if (product != null) {
      // Determine icon from product category
      icon = _resolveIcon(product.category);

      // Build capabilities from product capability instances + device state
      for (final capInstance in product.capabilityInstances) {
        // Skip system-diagnostics from main capability list (handled separately)
        if (capInstance.capabilityId == 'system-diagnostics') continue;

        // Process state_properties — these are the controllable/readable values
        for (final entry in capInstance.stateProperties.entries) {
          final stateKey = entry.key;
          final propMeta = entry.value is Map<String, dynamic>
              ? entry.value as Map<String, dynamic>
              : <String, dynamic>{};

          final valueType = propMeta['value_type'] as String? ?? capInstance.valueType;
          final validation = propMeta['validation'] as Map<String, dynamic>? ??
              capInstance.validation;

          // Determine the UI widget type from the backend value_type
          final widgetType = _resolveWidgetType(valueType, stateKey, validation);

          // Get the current value from device state
          final currentValue = deviceDto.state[stateKey];

          // Find the primary command action for this capability instance
          String? action;
          if (capInstance.commands.isNotEmpty) {
            action = capInstance.commands.first.action;
          }

          // Build properties map for the widget
          final properties = <String, dynamic>{};
          if (validation.containsKey('min')) properties['min'] = validation['min'];
          if (validation.containsKey('max')) properties['max'] = validation['max'];
          if (validation.containsKey('step')) properties['step'] = validation['step'];
          if (validation.containsKey('options')) properties['options'] = validation['options'];
          if (validation.containsKey('unit')) properties['unit'] = validation['unit'];

          capabilities.add(CapabilityModel(
            id: stateKey,
            type: widgetType,
            name: _humaniseName(stateKey),
            value: currentValue,
            properties: properties,
            isReadOnly: false,
            instance: capInstance.instance,
            action: action,
          ));
        }

        // Process diagnostic_properties — read-only sensor values
        for (final entry in capInstance.diagnosticProperties.entries) {
          final diagKey = entry.key;
          final propMeta = entry.value is Map<String, dynamic>
              ? entry.value as Map<String, dynamic>
              : <String, dynamic>{};

          final currentValue = deviceDto.diagnostics[diagKey] ?? deviceDto.state[diagKey];

          final properties = <String, dynamic>{};
          final validation = propMeta['validation'] as Map<String, dynamic>? ?? {};
          if (validation.containsKey('unit')) properties['unit'] = validation['unit'];

          capabilities.add(CapabilityModel(
            id: diagKey,
            type: 'sensor',
            name: _humaniseName(diagKey),
            value: currentValue,
            properties: properties,
            isReadOnly: true,
            instance: capInstance.instance,
          ));
        }
      }

      // Fallback: If product has no capability instances but device has state,
      // create generic capabilities from raw state keys
      if (capabilities.isEmpty && deviceDto.state.isNotEmpty) {
        capabilities = _buildFromRawState(deviceDto.state);
      }
    } else {
      // No product catalog — build generic capabilities from raw state
      if (deviceDto.state.isNotEmpty) {
        capabilities = _buildFromRawState(deviceDto.state);
      }
    }

    return DeviceModel(
      mac: deviceDto.mac,
      ownerId: deviceDto.ownerId,
      name: deviceDto.name.isNotEmpty ? deviceDto.name : 'Thiết bị ${deviceDto.mac}',
      productId: deviceDto.productId,
      icon: icon,
      status: deviceDto.isOnline ? DeviceStatus.online : DeviceStatus.offline,
      rawState: deviceDto.state,
      diagnostics: deviceDto.diagnostics,
      capabilities: capabilities,
      lastSeen: deviceDto.lastSeen,
      rssi: deviceDto.rssi,
      battery: deviceDto.battery,
    );
  }

  /// Resolve widget type from backend value_type.
  static String _resolveWidgetType(String valueType, String stateKey, Map<String, dynamic> validation) {
    // Special case: known boolean state keys
    if (stateKey == 'on_off' || stateKey == 'power' || stateKey == 'is_on') {
      return 'on_off';
    }

    switch (valueType) {
      case 'boolean':
        return 'on_off';
      case 'integer':
      case 'float':
        // If it has min/max range, render as slider
        if (validation.containsKey('min') && validation.containsKey('max')) {
          return 'range';
        }
        return 'sensor'; // Numeric without range → sensor display
      case 'enum':
        return 'enum';
      case 'string':
        if (validation.containsKey('options')) {
          return 'enum';
        }
        return 'unknown';
      default:
        return 'unknown';
    }
  }

  /// Build generic capabilities from raw state when no product catalog is available.
  static List<CapabilityModel> _buildFromRawState(Map<String, dynamic> state) {
    return state.entries.map((entry) {
      final value = entry.value;
      String type = 'unknown';

      if (value is bool) {
        type = 'on_off';
      } else if (value is num) {
        type = 'sensor';
      }

      return CapabilityModel(
        id: entry.key,
        type: type,
        name: _humaniseName(entry.key),
        value: value,
        isReadOnly: type == 'sensor',
      );
    }).toList();
  }

  /// Convert snake_case state key to a human-readable name.
  static String _humaniseName(String key) {
    const nameMap = {
      'on_off': 'Nguồn',
      'power': 'Nguồn',
      'brightness': 'Độ sáng',
      'temperature': 'Nhiệt độ',
      'humidity': 'Độ ẩm',
      'color': 'Màu sắc',
      'mode': 'Chế độ',
      'fan_speed': 'Tốc độ quạt',
      'curtain_position': 'Vị trí rèm',
      'door_lock': 'Khoá cửa',
      'rssi': 'Tín hiệu',
      'battery': 'Pin',
      'uptime': 'Thời gian hoạt động',
    };

    return nameMap[key] ?? key.replaceAll('_', ' ').replaceFirstMapped(
      RegExp(r'^.'),
      (m) => m.group(0)!.toUpperCase(),
    );
  }

  /// Resolve device icon from product category.
  static IconData _resolveIcon(String category) {
    const iconMap = {
      'light': LucideIcons.lightbulb,
      'led': LucideIcons.lightbulb,
      'ac': LucideIcons.wind,
      'hvac': LucideIcons.wind,
      'switch': LucideIcons.toggleLeft,
      'socket': LucideIcons.toggleLeft,
      'sensor': LucideIcons.activity,
      'camera': LucideIcons.camera,
      'curtain': LucideIcons.blinds,
      'door': LucideIcons.doorOpen,
      'fan': LucideIcons.fan,
      'thermostat': LucideIcons.thermometer,
    };
    return iconMap[category] ?? LucideIcons.box;
  }
}
