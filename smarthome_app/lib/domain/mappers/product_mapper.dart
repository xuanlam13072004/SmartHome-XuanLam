import '../../data/models/dto/product_dto.dart';
import '../models/product_model.dart';

class ProductMapper {
  static ProductModel fromDto(ProductDto dto) {
    return ProductModel(
      id: dto.id,
      manufacturer: dto.manufacturer,
      modelName: dto.modelName,
      displayName: dto.displayName,
      category: dto.category,
      icon: dto.icon,
      defaultState: dto.defaultState,
      allowedCommandActions: dto.allowedCommandActions,
    );
  }
}
