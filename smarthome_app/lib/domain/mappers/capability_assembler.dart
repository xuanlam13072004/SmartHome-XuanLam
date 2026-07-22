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

          final valueType =
              propMeta['value_type'] as String? ?? capInstance.valueType;
          final validation = propMeta['validation'] as Map<String, dynamic>? ??
              capInstance.validation;

          // Determine the UI widget type from the backend value_type
          final widgetType =
              _resolveWidgetType(valueType, stateKey, validation);

          // Get the current value from device state
          final currentValue = deviceDto.state[stateKey];

          final commandDescriptors = _commandsForState(
            capInstance,
            stateKey,
            valueType,
            validation,
          );

          // Build properties map for the widget
          final properties = <String, dynamic>{};
          if (validation.containsKey('min')) {
            properties['min'] = validation['min'];
          }
          if (validation.containsKey('max')) {
            properties['max'] = validation['max'];
          }
          if (validation.containsKey('step')) {
            properties['step'] = validation['step'];
          }
          if (validation.containsKey('options')) {
            properties['options'] = validation['options'];
          }
          if (validation.containsKey('enum')) {
            properties['options'] = validation['enum'];
          }
          if (validation.containsKey('unit')) {
            properties['unit'] = validation['unit'];
          }

          capabilities.add(CapabilityModel(
            id: stateKey,
            type: widgetType,
            name: _humaniseName(stateKey),
            value: currentValue,
            properties: properties,
            isReadOnly: commandDescriptors.isEmpty,
            instance: capInstance.instance,
            action: commandDescriptors.isNotEmpty
                ? commandDescriptors.first.action
                : null,
            commands: commandDescriptors,
          ));
        }

        // Process diagnostic_properties — read-only sensor values
        for (final entry in capInstance.diagnosticProperties.entries) {
          final diagKey = entry.key;
          final propMeta = entry.value is Map<String, dynamic>
              ? entry.value as Map<String, dynamic>
              : <String, dynamic>{};

          final currentValue =
              deviceDto.diagnostics[diagKey] ?? deviceDto.state[diagKey];

          final properties = <String, dynamic>{};
          final validation =
              propMeta['validation'] as Map<String, dynamic>? ?? {};
          if (validation.containsKey('unit')) {
            properties['unit'] = validation['unit'];
          }

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
      name: deviceDto.name.isNotEmpty
          ? deviceDto.name
          : 'Thiết bị ${deviceDto.mac}',
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
  static String _resolveWidgetType(
      String valueType, String stateKey, Map<String, dynamic> validation) {
    // Special case: known boolean state keys
    if (stateKey == 'on_off' || stateKey == 'power' || stateKey == 'is_on') {
      return 'on_off';
    }

    switch (valueType) {
      case 'boolean':
        return 'on_off';
      case 'integer':
      case 'float':
      case 'number':
        // If it has min/max range, render as slider
        if (validation.containsKey('min') && validation.containsKey('max')) {
          return 'range';
        }
        return 'sensor'; // Numeric without range → sensor display
      case 'enum':
        return 'enum';
      case 'string':
        if (validation.containsKey('options') ||
            validation.containsKey('enum')) {
          return 'enum';
        }
        return 'unknown';
      default:
        return 'unknown';
    }
  }

  static List<CapabilityCommandDescriptor> _commandsForState(
    CapabilityInstance instance,
    String stateKey,
    String valueType,
    Map<String, dynamic> validation,
  ) {
    if (_isClearlyReportedState(stateKey)) {
      return const [];
    }

    final descriptors = <CapabilityCommandDescriptor>[];
    final normalizedState = _normalizeToken(stateKey);
    final stateCount = instance.stateProperties.length;

    for (final command in instance.commands) {
      final argumentNames = command.arguments
          .map((argument) => argument['name']?.toString() ?? '')
          .where((name) => name.isNotEmpty)
          .toList();

      // Generic controls can safely supply only zero or one argument. Commands
      // with multiple arguments require a purpose-built form.
      if (argumentNames.length > 1) continue;

      if (argumentNames.isEmpty) {
        if (_zeroArgumentCommandMatchesState(
          command.action,
          stateKey,
          valueType,
          validation,
        )) {
          descriptors.add(CapabilityCommandDescriptor(
            action: command.action,
          ));
        }
        continue;
      }

      final argumentName = argumentNames.single;
      final normalizedArgument = _normalizeToken(argumentName);
      final normalizedAction = _normalizeToken(command.action);
      final exactMatch = normalizedArgument == normalizedState;
      final suffixMatch = normalizedState.endsWith(normalizedArgument) ||
          normalizedArgument.endsWith(normalizedState);
      final genericValueMatch = normalizedArgument == 'value' &&
          (stateCount == 1 ||
              normalizedAction.contains(normalizedState) ||
              (normalizedState == 'onoff' &&
                  (normalizedAction.contains('power') ||
                      normalizedAction.contains('switch'))) ||
              (normalizedState == 'power' &&
                  normalizedAction.contains('power')));

      if (exactMatch || suffixMatch || genericValueMatch) {
        descriptors.add(CapabilityCommandDescriptor(
          action: command.action,
          argumentNames: [argumentName],
        ));
      }
    }

    return descriptors;
  }

  static String _normalizeToken(String value) {
    return value.toLowerCase().replaceAll(RegExp(r'[^a-z0-9]'), '');
  }

  static bool _isClearlyReportedState(String stateKey) {
    final normalized = stateKey.toLowerCase();
    return normalized.startsWith('current_') ||
        normalized.startsWith('actual_') ||
        normalized.startsWith('reported_') ||
        normalized.startsWith('measured_') ||
        normalized.startsWith('last_') ||
        normalized.endsWith('_url') ||
        normalized.endsWith('_timestamp') ||
        normalized.endsWith('_at');
  }

  static bool _zeroArgumentCommandMatchesState(
    String action,
    String stateKey,
    String valueType,
    Map<String, dynamic> validation,
  ) {
    // Generic controls can express a zero-argument command only when the
    // property itself represents a finite desired state (boolean/enum).
    final options = validation['enum'] ?? validation['options'];
    if (valueType != 'boolean' && options is! List) {
      return false;
    }

    final normalizedAction = _normalizeToken(action);
    final stateTokens = stateKey
        .toLowerCase()
        .split('_')
        .where((token) =>
            token.isNotEmpty &&
            !const {'is', 'has', 'state', 'status', 'active', 'enabled'}
                .contains(token))
        .map((token) => token.endsWith('ing')
            ? token.substring(0, token.length - 3)
            : token);

    if (stateTokens.any((token) =>
        token.length >= 4 &&
        (normalizedAction.contains(token) ||
            token.startsWith(normalizedAction)))) {
      return true;
    }

    if (options is List) {
      for (final option in options) {
        final normalizedOption = option.toString().toLowerCase();
        final aliases = switch (normalizedOption) {
          'locked' => const ['lock'],
          'unlocked' => const ['unlock'],
          'opening' => const ['open'],
          'closing' => const ['close'],
          'stopped' => const ['stop'],
          _ => [normalizedOption],
        };
        if (aliases.any((alias) => normalizedAction.contains(alias))) {
          return true;
        }
      }
    }

    return false;
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

    return nameMap[key] ??
        key.replaceAll('_', ' ').replaceFirstMapped(
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
