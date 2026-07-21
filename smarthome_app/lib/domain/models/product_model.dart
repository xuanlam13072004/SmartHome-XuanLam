/// Represents a compiled product from the backend catalog.
/// Contains capability metadata needed for dynamic widget rendering.
class ProductModel {
  final String id;
  final String manufacturer;
  final String modelName;
  final String displayName;
  final String firmwareFamily;
  final String connectivity;
  final String category;
  final String icon;
  final String description;
  final Map<String, dynamic> defaultState;

  /// Parsed capability instances for this product.
  /// Each entry contains:
  /// - capability_id: String
  /// - instance: String (e.g. 'main', 'warm_white')
  /// - value_type: String ('boolean', 'integer', 'float', 'string', 'enum')
  /// - validation: Map (min, max, step, options, etc.)
  /// - state_properties: `Map<String, {value_type, validation}>`
  /// - diagnostic_properties: `Map<String, {value_type, validation}>`
  /// - commands: `List<{action, arguments}>`
  final List<CapabilityInstance> capabilityInstances;

  ProductModel({
    required this.id,
    required this.manufacturer,
    required this.modelName,
    required this.displayName,
    required this.firmwareFamily,
    required this.connectivity,
    required this.category,
    required this.icon,
    required this.description,
    required this.defaultState,
    required this.capabilityInstances,
  });
}

/// A capability instance as compiled by the backend catalog cache.
class CapabilityInstance {
  final String capabilityId;
  final String instance;
  final String valueType;
  final Map<String, dynamic> validation;
  final Map<String, dynamic> stateProperties;
  final Map<String, dynamic> diagnosticProperties;
  final List<CapabilityCommand> commands;

  CapabilityInstance({
    required this.capabilityId,
    required this.instance,
    required this.valueType,
    required this.validation,
    required this.stateProperties,
    required this.diagnosticProperties,
    required this.commands,
  });

  factory CapabilityInstance.fromJson(Map<String, dynamic> json) {
    final commandsList = <CapabilityCommand>[];
    if (json['commands'] is List) {
      for (final cmd in json['commands'] as List) {
        if (cmd is Map<String, dynamic>) {
          commandsList.add(CapabilityCommand.fromJson(cmd));
        }
      }
    }

    return CapabilityInstance(
      capabilityId: json['capability_id'] as String? ?? '',
      instance: json['instance'] as String? ?? '',
      valueType: json['value_type'] as String? ?? '',
      validation: json['validation'] as Map<String, dynamic>? ?? {},
      stateProperties: json['state_properties'] as Map<String, dynamic>? ?? {},
      diagnosticProperties: json['diagnostic_properties'] as Map<String, dynamic>? ?? {},
      commands: commandsList,
    );
  }
}

/// A command definition from the product catalog.
class CapabilityCommand {
  final String action;
  final List<Map<String, dynamic>> arguments;

  CapabilityCommand({
    required this.action,
    required this.arguments,
  });

  factory CapabilityCommand.fromJson(Map<String, dynamic> json) {
    final args = <Map<String, dynamic>>[];
    if (json['arguments'] is List) {
      for (final arg in json['arguments'] as List) {
        if (arg is Map<String, dynamic>) {
          args.add(arg);
        } else if (arg is String) {
          args.add({'name': arg});
        }
      }
    }
    return CapabilityCommand(
      action: json['action'] as String? ?? '',
      arguments: args,
    );
  }
}
