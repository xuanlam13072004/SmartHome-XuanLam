import '../../data/models/dto/product_dto.dart';
import '../models/product_model.dart';

class ProductMapper {
  static ProductModel fromDto(ProductDto dto) {
    return ProductModel(
      id: dto.id,
      manufacturer: dto.manufacturer,
      modelName: dto.modelName,
      displayName: dto.displayName,
      firmwareFamily: dto.firmwareFamily,
      connectivity: dto.connectivity,
      category: dto.category,
      icon: dto.icon,
      description: dto.description,
      defaultState: dto.defaultState,
      capabilityInstances: dto.capabilityInstances
          .map((json) => CapabilityInstance.fromJson(json))
          .toList(),
    );
  }
}
