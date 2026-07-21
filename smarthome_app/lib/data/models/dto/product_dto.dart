class ProductDto {
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

  /// Parsed capability instances with state/diagnostic schemas.
  /// Structure from backend (serialised from catalogCache):
  /// Each entry: { capability_id, instance, value_type, validation,
  ///   state_properties, diagnostic_properties, commands }
  final List<Map<String, dynamic>> capabilityInstances;

  ProductDto({
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

  factory ProductDto.fromJson(Map<String, dynamic> json) {
    // The backend getAllProducts() serialises compiled products.
    // capabilityInstances may not be present in the current API response,
    // so we reconstruct from available fields.

    // Attempt to extract capability instances from the response
    List<Map<String, dynamic>> instances = [];
    if (json['capabilityInstances'] is List) {
      instances = (json['capabilityInstances'] as List)
          .map((e) => e as Map<String, dynamic>)
          .toList();
    }

    return ProductDto(
      id: json['_id'] as String? ?? '',
      manufacturer: json['manufacturer'] as String? ?? '',
      modelName: json['model_name'] as String? ?? '',
      displayName: json['display_name'] as String? ?? '',
      firmwareFamily: json['firmware_family'] as String? ?? 'generic',
      connectivity: json['connectivity'] as String? ?? 'wifi',
      category: json['category'] as String? ?? '',
      icon: json['icon'] as String? ?? '',
      description: json['description'] as String? ?? '',
      defaultState: json['default_state'] as Map<String, dynamic>? ?? {},
      capabilityInstances: instances,
    );
  }
}
