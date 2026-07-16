class ProductModel {
  final String id;
  final String manufacturer;
  final String modelName;
  final String displayName;
  final String category;
  final String icon;
  final Map<String, dynamic> defaultState;
  final Map<String, dynamic> allowedCommandActions;

  ProductModel({
    required this.id,
    required this.manufacturer,
    required this.modelName,
    required this.displayName,
    required this.category,
    required this.icon,
    required this.defaultState,
    required this.allowedCommandActions,
  });
}
