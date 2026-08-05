import '../../data/models/dto/product_dto.dart';
import '../models/product_model.dart';

class ProductMapper {
  static ProductModel fromDto(ProductDto dto) {
    return ProductModel(
      id: dto.id,
      catalogRevision: dto.catalogRevision,
      uiProfile: dto.uiProfile,
      uiProfileVersion: dto.uiProfileVersion,
      manufacturer: dto.manufacturer,
      modelName: dto.modelName,
      displayName: dto.displayName,
      firmwareFamily: dto.firmwareFamily,
      connectivityProfiles: dto.connectivityProfiles,
      category: dto.category,
      icon: dto.icon,
      description: dto.description,
      firmwareDefaultState: dto.firmwareDefaultState,
      capabilityInstances: dto.capabilityInstances
          .map((json) => CapabilityInstance.fromJson(json))
          .toList(),
    );
  }
}
