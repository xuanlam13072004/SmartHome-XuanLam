class CapabilityOperationDescriptor {
  const CapabilityOperationDescriptor({
    required this.operationName,
    this.inputNames = const [],
    this.inputSchema = const {},
    this.risk = 'normal',
    this.confirmation = 'none',
    this.label = '',
  });

  final String operationName;
  final List<String> inputNames;
  final Map<String, dynamic> inputSchema;
  final String risk;
  final String confirmation;
  final String label;
}

enum CapabilitySection {
  control,
  sensor,
  diagnostic,
}

class CapabilityModel {
  const CapabilityModel({
    required this.id,
    required this.type,
    required this.name,
    this.value,
    this.properties = const {},
    this.isReadOnly = false,
    this.instance = '',
    this.operations = const [],
    this.capabilityId = '',
    this.semanticRole = '',
    this.instanceDisplayName = '',
    this.iconName = '',
    this.displayOrder = 0,
    this.section = CapabilitySection.control,
  });

  final String id;
  final String type;
  final String name;
  final dynamic value;
  final Map<String, dynamic> properties;
  final bool isReadOnly;
  final String instance;
  final List<CapabilityOperationDescriptor> operations;
  final String capabilityId;
  final String semanticRole;
  final String instanceDisplayName;
  final String iconName;
  final int displayOrder;
  final CapabilitySection section;

  CapabilityOperationDescriptor resolveOperation(dynamic nextValue) {
    final singleInput =
        operations.where((operation) => operation.inputNames.length == 1);
    if (singleInput.length == 1) return singleInput.single;

    final noInput =
        operations.where((operation) => operation.inputNames.isEmpty).toList();
    if (noInput.isNotEmpty) {
      final tokens = _desiredOperationTokens(nextValue);
      for (final operation in noInput) {
        final name = operation.operationName.toLowerCase();
        if (tokens.any(name.contains)) return operation;
      }
      if (noInput.length == 1) return noInput.single;
    }

    throw StateError(
      'No unambiguous operation mapping for capability $instance.$id',
    );
  }

  CapabilityModel copyWith({
    String? id,
    String? type,
    String? name,
    dynamic value,
    Map<String, dynamic>? properties,
    bool? isReadOnly,
    String? instance,
    List<CapabilityOperationDescriptor>? operations,
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
      operations: operations ?? this.operations,
      capabilityId: capabilityId ?? this.capabilityId,
      semanticRole: semanticRole ?? this.semanticRole,
      instanceDisplayName: instanceDisplayName ?? this.instanceDisplayName,
      iconName: iconName ?? this.iconName,
      displayOrder: displayOrder ?? this.displayOrder,
      section: section ?? this.section,
    );
  }
}

List<String> _desiredOperationTokens(dynamic value) {
  if (value is bool) {
    return value
        ? const ['on', 'enable', 'start', 'open', 'lock']
        : const ['off', 'disable', 'stop', 'close', 'unlock'];
  }

  final normalized = value.toString().toLowerCase();
  const aliases = {
    'locked': ['lock'],
    'unlocked': ['unlock'],
    'open': ['open'],
    'opened': ['open'],
    'closed': ['close'],
    'opening': ['open'],
    'closing': ['close'],
    'stopped': ['stop'],
  };
  return aliases[normalized] ?? [normalized];
}
