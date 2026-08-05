class ProductModel {
  const ProductModel({
    required this.id,
    required this.catalogRevision,
    required this.uiProfile,
    required this.uiProfileVersion,
    required this.manufacturer,
    required this.modelName,
    required this.displayName,
    required this.firmwareFamily,
    required this.connectivityProfiles,
    required this.category,
    required this.icon,
    required this.description,
    required this.firmwareDefaultState,
    required this.capabilityInstances,
  });

  final String id;
  final int catalogRevision;
  final String uiProfile;
  final int uiProfileVersion;
  final String manufacturer;
  final String modelName;
  final String displayName;
  final String firmwareFamily;
  final List<String> connectivityProfiles;
  final String category;
  final String icon;
  final String description;
  final Map<String, dynamic> firmwareDefaultState;
  final List<CapabilityInstance> capabilityInstances;
}

class CapabilityInstance {
  const CapabilityInstance({
    required this.capabilityId,
    required this.instance,
    required this.semanticRole,
    required this.displayName,
    required this.icon,
    required this.section,
    required this.displayOrder,
    required this.properties,
    required this.operations,
    required this.resources,
    required this.credentials,
  });

  final String capabilityId;
  final String instance;
  final String semanticRole;
  final String displayName;
  final String icon;
  final String section;
  final int displayOrder;
  final List<CapabilityProperty> properties;
  final List<CapabilityOperation> operations;
  final List<CapabilityResource> resources;
  final List<CapabilityCredential> credentials;

  factory CapabilityInstance.fromJson(Map<String, dynamic> json) {
    final presentation = _map(json['presentation']);
    return CapabilityInstance(
      capabilityId: json['capability_id']?.toString() ?? '',
      instance: json['instance_id']?.toString() ?? '',
      semanticRole: json['semantic_role']?.toString() ?? '',
      displayName: presentation['display_name']?.toString() ?? '',
      icon: presentation['icon']?.toString() ?? '',
      section: presentation['section']?.toString() ?? '',
      displayOrder: _int(presentation['order']) ?? 0,
      properties: (json['properties'] as List? ?? const [])
          .whereType<Map<Object?, Object?>>()
          .map((value) => CapabilityProperty.fromJson(
                Map<String, dynamic>.from(value),
              ))
          .toList(growable: false),
      operations: (json['operations'] as List? ?? const [])
          .whereType<Map<Object?, Object?>>()
          .map((value) => CapabilityOperation.fromJson(
                Map<String, dynamic>.from(value),
              ))
          .toList(growable: false),
      resources: (json['resources'] as List? ?? const [])
          .whereType<Map<Object?, Object?>>()
          .map((value) => CapabilityResource.fromJson(
                Map<String, dynamic>.from(value),
              ))
          .toList(growable: false),
      credentials: (json['credentials'] as List? ?? const [])
          .whereType<Map<Object?, Object?>>()
          .map((value) => CapabilityCredential.fromJson(
                Map<String, dynamic>.from(value),
              ))
          .toList(growable: false),
    );
  }
}

class CapabilityResource {
  const CapabilityResource({
    required this.id,
    required this.kind,
    required this.permission,
    required this.sessionTtlSeconds,
  });

  final String id;
  final String kind;
  final String permission;
  final int sessionTtlSeconds;

  factory CapabilityResource.fromJson(Map<String, dynamic> json) =>
      CapabilityResource(
        id: json['id']?.toString() ?? '',
        kind: json['kind']?.toString() ?? '',
        permission: json['permission']?.toString() ?? '',
        sessionTtlSeconds: _int(json['session_ttl_seconds']) ?? 0,
      );
}

class CapabilityCredential {
  const CapabilityCredential({
    required this.id,
    required this.kind,
    required this.permission,
    required this.writeOnly,
    required this.constraints,
  });

  final String id;
  final String kind;
  final String permission;
  final bool writeOnly;
  final Map<String, dynamic> constraints;

  factory CapabilityCredential.fromJson(Map<String, dynamic> json) =>
      CapabilityCredential(
        id: json['id']?.toString() ?? '',
        kind: json['kind']?.toString() ?? '',
        permission: json['permission']?.toString() ?? '',
        writeOnly: json['write_only'] == true,
        constraints: _map(json['constraints']),
      );
}

class DeviceResourceDefinition {
  const DeviceResourceDefinition({
    required this.instanceId,
    required this.definition,
  });
  final String instanceId;
  final CapabilityResource definition;
}

class DeviceCredentialDefinition {
  const DeviceCredentialDefinition({
    required this.instanceId,
    required this.definition,
  });
  final String instanceId;
  final CapabilityCredential definition;
}

class CapabilityProperty {
  const CapabilityProperty({
    required this.id,
    required this.channel,
    required this.path,
    required this.type,
    required this.schema,
  });

  final String id;
  final String channel;
  final String path;
  final String type;
  final Map<String, dynamic> schema;

  factory CapabilityProperty.fromJson(Map<String, dynamic> json) =>
      CapabilityProperty(
        id: json['id']?.toString() ?? '',
        channel: json['channel']?.toString() ?? 'reported',
        path: json['path']?.toString() ?? '',
        type: json['type']?.toString() ?? 'string',
        schema: Map<String, dynamic>.from(json),
      );
}

class CapabilityOperation {
  const CapabilityOperation({
    required this.id,
    required this.input,
    required this.effects,
    required this.permission,
    required this.risk,
    required this.confirmation,
    required this.presentation,
    this.ackReference,
  });

  final String id;
  final Map<String, dynamic> input;
  final List<Map<String, dynamic>> effects;
  final String permission;
  final String risk;
  final String confirmation;
  final Map<String, dynamic> presentation;
  final String? ackReference;

  factory CapabilityOperation.fromJson(Map<String, dynamic> json) {
    final ack = _map(json['ack_policy']);
    return CapabilityOperation(
      id: json['id']?.toString() ?? '',
      input: _map(json['input']),
      effects: (json['effects'] as List? ?? const [])
          .whereType<Map<Object?, Object?>>()
          .map((value) => Map<String, dynamic>.from(value))
          .toList(growable: false),
      permission: json['permission']?.toString() ?? '',
      risk: json['risk']?.toString() ?? 'normal',
      confirmation: json['confirmation']?.toString() ?? 'none',
      presentation: _map(json['presentation']),
      ackReference: ack['reference']?.toString(),
    );
  }
}

Map<String, dynamic> _map(dynamic value) => value is Map
    ? Map<String, dynamic>.from(value)
    : <String, dynamic>{};

int? _int(dynamic value) {
  if (value is num) return value.toInt();
  return int.tryParse(value?.toString() ?? '');
}
