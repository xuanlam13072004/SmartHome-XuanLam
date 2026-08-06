import 'package:flutter/material.dart';
import 'package:lucide_icons/lucide_icons.dart';
import '../../core/widgets/indicators/status_badge.dart' show DeviceStatus;
import '../../data/models/dto/device_dto.dart';
import '../../features/dashboard/models/capability_model.dart';
import '../models/device_model.dart';
import '../models/device_topology.dart';
import '../models/product_model.dart';

class CapabilityAssembler {
  static DeviceModel assemble(DeviceDto deviceDto, ProductModel? product) {
    final capabilities = <CapabilityModel>[];
    final rawState = _flattenReportedState(deviceDto.instances);

    if (product != null) {
      final orderedInstances = product.capabilityInstances.toList()
        ..sort((left, right) => left.displayOrder.compareTo(right.displayOrder));

      for (final instance in orderedInstances) {
        final attachedOperations = <String>{};
        for (final property in instance.properties) {
          if (property.channel == 'desired') continue;
          final operations = property.channel == 'reported'
              ? _operationsForProperty(
                  instance,
                  property,
                  deviceDto.permissions,
                )
              : const <CapabilityOperationDescriptor>[];
          for (final operation in operations) {
            attachedOperations.add(operation.operationName);
          }
          final isReadOnly = operations.isEmpty;
          capabilities.add(CapabilityModel(
            id: property.id,
            type: _widgetType(property, isReadOnly),
            name: _propertyDisplayName(instance, property),
            value: _propertyValue(deviceDto, instance.instance, property),
            properties: {
              ..._widgetProperties(property.schema),
              'state_version': deviceDto.stateVersion,
            },
            isReadOnly: isReadOnly,
            instance: instance.instance,
            operations: operations,
            capabilityId: instance.capabilityId,
            semanticRole: instance.semanticRole,
            instanceDisplayName: _instanceDisplayName(instance),
            iconName: instance.icon,
            displayOrder: instance.displayOrder,
            section: property.channel == 'diagnostic'
                ? CapabilitySection.diagnostic
                : isReadOnly
                    ? CapabilitySection.sensor
                    : CapabilitySection.control,
          ));
        }

        // Operations without a reported-state target remain visible as an
        // explicit action instead of disappearing from the Product UI.
        for (final operation in instance.operations) {
          if (operation.effects.any(
            (effect) => effect['type'] == 'create_resource_session',
          )) {
            continue;
          }
          if (!_mayInvoke(operation, deviceDto.permissions)) continue;
          if (attachedOperations.contains(operation.id)) continue;
          final inputNames = operation.input.keys.toList(growable: false);
          capabilities.add(CapabilityModel(
            id: operation.id,
            type: inputNames.isEmpty ? 'action' : 'operation',
            name: operation.presentation['label']?.toString() ??
                _humaniseName(operation.id),
            isReadOnly: false,
            instance: instance.instance,
            operations: [_operationDescriptor(operation)],
            capabilityId: instance.capabilityId,
            semanticRole: instance.semanticRole,
            instanceDisplayName: _instanceDisplayName(instance),
            iconName: instance.icon,
            displayOrder: instance.displayOrder,
            section: CapabilitySection.control,
          ));
        }
      }
    }

    if (capabilities.isEmpty) {
      capabilities.addAll(_buildFromRawState(rawState));
    }

    return DeviceModel(
      mac: deviceDto.mac,
      ownerId: deviceDto.ownerId,
      name: deviceDto.name.isNotEmpty
          ? deviceDto.name
          : 'Thiết bị ${deviceDto.mac}',
      productId: deviceDto.productId,
      uiProfile: product?.uiProfile ?? 'generic',
      uiProfileVersion: product?.uiProfileVersion ?? 1,
      category: product?.category ?? '',
      icon: _resolveIcon(product?.category ?? ''),
      status: deviceDto.isOnline ? DeviceStatus.online : DeviceStatus.offline,
      stateVersion: deviceDto.stateVersion,
      instances: deviceDto.instances,
      rawState: rawState,
      diagnostics: deviceDto.diagnostics,
      permissions: deviceDto.permissions,
      membershipRole: deviceDto.membershipRole,
      capabilities: capabilities,
      lastSeen: deviceDto.lastSeen,
      topology: deviceDto.networkId == null || deviceDto.topologyEpoch == null
          ? null
          : DeviceTopology(
              networkId: deviceDto.networkId!,
              role: DeviceTopologyRole.fromWire(deviceDto.topologyRole),
              epoch: deviceDto.topologyEpoch!,
              state: DeviceTopologyState.fromWire(deviceDto.topologyState),
              transportMode:
                  DeviceTransportMode.fromWire(deviceDto.transportMode),
              joinRank: deviceDto.joinRank,
              activeHubMac: deviceDto.activeHubMac,
              lastTransportChange: deviceDto.lastTransportChange,
            ),
      resources: product?.capabilityInstances
              .expand((instance) => instance.resources
                  .where((resource) =>
                      deviceDto.permissions.contains(resource.permission))
                  .map((resource) => DeviceResourceDefinition(
                        instanceId: instance.instance,
                        definition: resource,
                      )))
              .toList(growable: false) ??
          const [],
      credentials: deviceDto.membershipRole == 'owner'
          ? product?.capabilityInstances
                  .expand((instance) => instance.credentials
                      .where((credential) => deviceDto.permissions
                          .contains(credential.permission))
                      .map((credential) => DeviceCredentialDefinition(
                            instanceId: instance.instance,
                            definition: credential,
                          )))
                  .toList(growable: false) ??
              const []
          : const [],
    );
  }

  static List<CapabilityOperationDescriptor> _operationsForProperty(
    CapabilityInstance instance,
    CapabilityProperty property,
    List<String> permissions,
  ) {
    return instance.operations.where((operation) {
      if (!_mayInvoke(operation, permissions)) return false;
      if (operation.ackReference == property.id) return true;
      for (final effect in operation.effects) {
        final target = effect['property']?.toString();
        if (target == property.id || target == 'target_${property.id}') {
          return true;
        }
      }
      return false;
    }).map(_operationDescriptor).toList(growable: false);
  }

  static bool _mayInvoke(
    CapabilityOperation operation,
    List<String> permissions,
  ) =>
      operation.permission.isNotEmpty &&
      permissions.contains(operation.permission);

  static CapabilityOperationDescriptor _operationDescriptor(
    CapabilityOperation operation,
  ) => CapabilityOperationDescriptor(
        operationName: operation.id,
        inputNames: operation.input.keys.toList(growable: false),
        risk: operation.risk,
        confirmation: operation.confirmation,
        label: operation.presentation['label']?.toString() ?? '',
      );

  static dynamic _propertyValue(
    DeviceDto device,
    String instanceId,
    CapabilityProperty property,
  ) {
    if (property.channel == 'diagnostic') {
      final diagnostics = device.diagnostics[instanceId];
      return diagnostics is Map ? diagnostics[property.id] : null;
    }
    final envelope = device.instances[instanceId];
    if (envelope is! Map) return null;
    final channel = envelope[property.channel];
    return channel is Map ? channel[property.id] : null;
  }

  static Map<String, dynamic> _flattenReportedState(
    Map<String, dynamic> instances,
  ) {
    final result = <String, dynamic>{};
    for (final envelope in instances.values) {
      if (envelope is! Map) continue;
      final reported = envelope['reported'];
      if (reported is Map) {
        for (final entry in reported.entries) {
          result[entry.key.toString()] = entry.value;
        }
      }
    }
    return result;
  }

  static Map<String, dynamic> _widgetProperties(Map<String, dynamic> schema) {
    final properties = <String, dynamic>{};
    if (schema.containsKey('minimum')) properties['min'] = schema['minimum'];
    if (schema.containsKey('maximum')) properties['max'] = schema['maximum'];
    if (schema.containsKey('multiple_of')) properties['step'] = schema['multiple_of'];
    if (schema.containsKey('enum')) properties['options'] = schema['enum'];
    if (schema.containsKey('unit')) properties['unit'] = schema['unit'];
    return properties;
  }

  static String _widgetType(CapabilityProperty property, bool isReadOnly) {
    if (property.schema['enum'] is List) return isReadOnly ? 'sensor' : 'enum';
    if (property.type == 'boolean') return isReadOnly ? 'sensor' : 'on_off';
    if (property.type == 'number' || property.type == 'integer') {
      return isReadOnly ? 'sensor' : 'range';
    }
    return isReadOnly ? 'sensor' : 'unknown';
  }

  static List<CapabilityModel> _buildFromRawState(
    Map<String, dynamic> state,
  ) => state.entries.map((entry) => CapabilityModel(
        id: entry.key,
        type: 'sensor',
        name: _humaniseName(entry.key),
        value: entry.value,
        isReadOnly: true,
        section: CapabilitySection.sensor,
      )).toList(growable: false);

  static String _propertyDisplayName(
    CapabilityInstance instance,
    CapabilityProperty property,
  ) {
    final visibleProperties = instance.properties
        .where((value) => value.channel != 'desired')
        .length;
    if (visibleProperties == 1 && instance.displayName.trim().isNotEmpty) {
      return instance.displayName.trim();
    }
    return _humaniseName(property.id);
  }

  static String _instanceDisplayName(CapabilityInstance instance) =>
      instance.displayName.trim().isNotEmpty
          ? instance.displayName.trim()
          : _humaniseName(instance.instance.isNotEmpty
              ? instance.instance
              : instance.capabilityId);

  static String _humaniseName(String key) => key
      .replaceAll('_', ' ')
      .replaceFirstMapped(RegExp(r'^.'), (match) => match.group(0)!.toUpperCase());

  static IconData _resolveIcon(String category) => switch (category) {
        'security' => LucideIcons.shield,
        'environment' => LucideIcons.cloudRain,
        'safety' => LucideIcons.alertTriangle,
        'agriculture' => LucideIcons.sprout,
        'camera' => LucideIcons.camera,
        _ => LucideIcons.box,
      };
}
