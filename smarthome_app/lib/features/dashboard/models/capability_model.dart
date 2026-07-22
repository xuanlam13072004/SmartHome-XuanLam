class CapabilityCommandDescriptor {
  final String action;
  final List<String> argumentNames;

  const CapabilityCommandDescriptor({
    required this.action,
    this.argumentNames = const [],
  });
}

/// Represents a single capability rendered in the device detail UI.
/// Built from Product Catalog data + device state, NOT hardcoded.
class CapabilityModel {
  final String id; // State key (e.g. 'on_off', 'brightness')
  final String
      type; // Widget type: 'on_off', 'range', 'sensor', 'enum', 'unknown'
  final String name; // Display name
  final dynamic value; // Current value from device state
  final Map<String, dynamic>
      properties; // metadata: min, max, step, options, unit...
  final bool isReadOnly; // sensor/diagnostic = true
  final String
      instance; // Backend capability instance (e.g. 'main', 'warm_white')
  final String?
      action; // Command action to send (e.g. 'turn_on', 'set_brightness')
  final List<CapabilityCommandDescriptor> commands;

  const CapabilityModel({
    required this.id,
    required this.type,
    required this.name,
    this.value,
    this.properties = const {},
    this.isReadOnly = false,
    this.instance = '',
    this.action,
    this.commands = const [],
  });

  CapabilityModel copyWith({
    String? id,
    String? type,
    String? name,
    dynamic value,
    Map<String, dynamic>? properties,
    bool? isReadOnly,
    String? instance,
    String? action,
    List<CapabilityCommandDescriptor>? commands,
  }) {
    return CapabilityModel(
      id: id ?? this.id,
      type: type ?? this.type,
      name: name ?? this.name,
      value: value ?? this.value,
      properties: properties ?? this.properties,
      isReadOnly: isReadOnly ?? this.isReadOnly,
      instance: instance ?? this.instance,
      action: action ?? this.action,
      commands: commands ?? this.commands,
    );
  }
}
