class CapabilityCommandDescriptor {
  final String action;
  final List<String> argumentNames;

  const CapabilityCommandDescriptor({
    required this.action,
    this.argumentNames = const [],
  });
}

enum CapabilitySection {
  control,
  sensor,
  diagnostic,
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
  final String capabilityId;
  final String semanticRole;
  final String instanceDisplayName;
  final String iconName;
  final int displayOrder;
  final CapabilitySection section;

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
    this.capabilityId = '',
    this.semanticRole = '',
    this.instanceDisplayName = '',
    this.iconName = '',
    this.displayOrder = 0,
    this.section = CapabilitySection.control,
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
    String? capabilityId,
    String? semanticRole,
    String? instanceDisplayName,
    String? iconName,
    int? displayOrder,
    CapabilitySection? section,
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
      capabilityId: capabilityId ?? this.capabilityId,
      semanticRole: semanticRole ?? this.semanticRole,
      instanceDisplayName: instanceDisplayName ?? this.instanceDisplayName,
      iconName: iconName ?? this.iconName,
      displayOrder: displayOrder ?? this.displayOrder,
      section: section ?? this.section,
    );
  }
}
