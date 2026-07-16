class ProductDto {
  final String id;
  final String manufacturer;
  final String modelName;
  final String displayName;
  final String category;
  final String icon;
  final Map<String, dynamic> defaultState;
  final Map<String, dynamic> allowedCommandActions;

  ProductDto({
    required this.id,
    required this.manufacturer,
    required this.modelName,
    required this.displayName,
    required this.category,
    required this.icon,
    required this.defaultState,
    required this.allowedCommandActions,
  });

  factory ProductDto.fromJson(Map<String, dynamic> json) {
    return ProductDto(
      id: json['_id'] as String? ?? '',
      manufacturer: json['manufacturer'] as String? ?? '',
      modelName: json['model_name'] as String? ?? '',
      displayName: json['display_name'] as String? ?? '',
      category: json['category'] as String? ?? '',
      icon: json['icon'] as String? ?? '',
      defaultState: json['default_state'] as Map<String, dynamic>? ?? {},
      allowedCommandActions: json['allowedCommandActions'] as Map<String, dynamic>? ?? {},
    );
  }
}
