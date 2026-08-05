class ProductDto {
  const ProductDto({
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
  final List<Map<String, dynamic>> capabilityInstances;

  factory ProductDto.fromJson(Map<String, dynamic> json) {
    final presentation = _map(json['presentation']);
    final firmware = _map(json['firmware_compatibility']);
    return ProductDto(
      id: json['product_id']?.toString() ?? '',
      catalogRevision: _int(json['catalog_revision']) ?? 0,
      uiProfile: json['ui_profile']?.toString() ?? 'generic',
      uiProfileVersion: _int(json['ui_profile_version']) ?? 1,
      manufacturer: json['manufacturer']?.toString() ?? '',
      modelName: json['model_name']?.toString() ?? '',
      displayName: presentation['display_name']?.toString() ??
          json['model_name']?.toString() ??
          '',
      firmwareFamily: firmware['family']?.toString() ?? 'generic',
      connectivityProfiles: (json['connectivity_profiles'] as List? ?? const [])
          .map((value) => value.toString())
          .toList(growable: false),
      category: json['category']?.toString() ?? '',
      icon: presentation['icon']?.toString() ?? '',
      description: presentation['description']?.toString() ??
          json['description']?.toString() ??
          '',
      firmwareDefaultState: _map(json['firmware_default_state']),
      capabilityInstances: (json['capability_instances'] as List? ?? const [])
          .whereType<Map<Object?, Object?>>()
          .map((value) => Map<String, dynamic>.from(value))
          .toList(growable: false),
    );
  }

  static Map<String, dynamic> _map(dynamic value) => value is Map
      ? Map<String, dynamic>.from(value)
      : <String, dynamic>{};

  static int? _int(dynamic value) {
    if (value is num) return value.toInt();
    return int.tryParse(value?.toString() ?? '');
  }
}
