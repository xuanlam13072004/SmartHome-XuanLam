import '../../../domain/models/device_model.dart';
import '../../../domain/models/product_model.dart';
import '../../../data/datasources/remote/device_remote_data_source.dart';
import '../../../domain/mappers/capability_assembler.dart';
import '../../../domain/mappers/product_mapper.dart';

abstract class IDeviceRepository {
  Future<List<DeviceModel>> getDevices();
  Future<void> updateCapability(String deviceId, String capabilityId, dynamic value);
}

class ApiDeviceRepository implements IDeviceRepository {
  final IDeviceRemoteDataSource remoteDataSource;
  
  // In-memory cache for Product Catalog
  List<ProductModel>? _cachedProducts;

  ApiDeviceRepository(this.remoteDataSource);

  Future<List<ProductModel>> _getProducts() async {
    if (_cachedProducts != null) return _cachedProducts!;
    
    try {
      final productDtos = await remoteDataSource.getProducts();
      _cachedProducts = productDtos.map((dto) => ProductMapper.fromDto(dto)).toList();
      return _cachedProducts!;
    } catch (e) {
      return [];
    }
  }

  @override
  Future<List<DeviceModel>> getDevices() async {
    final products = await _getProducts();
    final deviceDtos = await remoteDataSource.getDevices();

    return deviceDtos.map((dto) {
      final product = products.where((p) => p.id == dto.productId).firstOrNull;
      return CapabilityAssembler.assemble(dto, product);
    }).toList();
  }

  @override
  Future<void> updateCapability(String deviceId, String capabilityId, dynamic value) async {
    // Backend endpoint: /devices/:mac/commands
    // deviceId chính là mac address
    final action = 'set_$capabilityId'; // Dựa theo rule chung, ví dụ set_on_off, set_brightness
    
    await remoteDataSource.sendCommand(deviceId, action, 'default', {
      'value': value,
    });
  }
}
