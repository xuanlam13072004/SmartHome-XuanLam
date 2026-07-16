import '../../models/dto/device_dto.dart';
import '../../models/dto/product_dto.dart';

abstract class IDeviceLocalDataSource {
  Future<List<ProductDto>> getCachedProducts();
  Future<void> cacheProducts(List<ProductDto> products);
  
  Future<List<DeviceDto>> getCachedDevices();
  Future<void> cacheDevices(List<DeviceDto> devices);
}

class DeviceLocalDataSourceImpl implements IDeviceLocalDataSource {
  // TODO: Implement later with Hive or SQLite
  // Tạm thời dùng In-memory
  List<ProductDto> _cachedProducts = [];
  List<DeviceDto> _cachedDevices = [];

  @override
  Future<List<ProductDto>> getCachedProducts() async => _cachedProducts;

  @override
  Future<void> cacheProducts(List<ProductDto> products) async {
    _cachedProducts = products;
  }

  @override
  Future<List<DeviceDto>> getCachedDevices() async => _cachedDevices;

  @override
  Future<void> cacheDevices(List<DeviceDto> devices) async {
    _cachedDevices = devices;
  }
}
