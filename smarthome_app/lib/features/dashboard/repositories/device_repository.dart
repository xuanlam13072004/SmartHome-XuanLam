import '../../../domain/models/device_model.dart';
import '../../../domain/models/product_model.dart';
import '../../../data/datasources/remote/device_remote_data_source.dart';
import '../../../data/models/dto/device_dto.dart';
import '../../../domain/mappers/capability_assembler.dart';
import '../../../domain/mappers/product_mapper.dart';
import '../../../core/widgets/indicators/status_badge.dart' show DeviceStatus;

abstract class IDeviceRepository {
  Future<List<DeviceModel>> getDevices();
  Future<void> updateCapability(String mac, String capabilityId,
      String instance, String action, dynamic value);
  Future<DeviceModel> claimDevice(String mac, String secretKey, {String? name});
  Future<DeviceModel> updateDeviceName(String mac, String name);
  Future<void> unpairDevice(String mac);
  Future<ProductModel?> getProduct(String productId);

  /// Assemble a DeviceModel from raw WS JSON data.
  Future<DeviceModel> assembleFromWsJson(Map<String, dynamic> rawJson);

  /// Build updated DeviceModel from telemetry event payload merge.
  Future<DeviceModel> mergeDeviceTelemetry(
      DeviceModel device, Map<String, dynamic> newPayload);

  /// Build updated DeviceModel with new online status.
  DeviceModel updateDeviceStatus(DeviceModel device, bool isOnline);

  void dispose();
}

class ApiDeviceRepository implements IDeviceRepository {
  final IDeviceRemoteDataSource remoteDataSource;
  // In-memory cache for Product Catalog
  List<ProductModel>? _cachedProducts;

  ApiDeviceRepository(this.remoteDataSource);

  @override
  void dispose() {
    // No owned stream subscriptions.
  }

  Future<List<ProductModel>> _getProducts() async {
    if (_cachedProducts != null) return _cachedProducts!;

    try {
      final productDtos = await remoteDataSource.getProducts();
      _cachedProducts =
          productDtos.map((dto) => ProductMapper.fromDto(dto)).toList();
      return _cachedProducts!;
    } catch (e) {
      return [];
    }
  }

  @override
  Future<ProductModel?> getProduct(String productId) async {
    final products = await _getProducts();
    return products.where((p) => p.id == productId).firstOrNull;
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
  Future<DeviceModel> assembleFromWsJson(Map<String, dynamic> rawJson) async {
    final dto = DeviceDto.fromJson(rawJson);
    final product = await getProduct(dto.productId);
    return CapabilityAssembler.assemble(dto, product);
  }

  @override
  Future<DeviceModel> mergeDeviceTelemetry(
      DeviceModel device, Map<String, dynamic> newPayload) async {
    final newRawState = Map<String, dynamic>.from(device.rawState);
    newRawState.addAll(newPayload);

    final product = await getProduct(device.productId);

    final dto = DeviceDto(
      mac: device.mac,
      ownerId: device.ownerId,
      name: device.name,
      productId: device.productId,
      isActive: true,
      isOnline: device.status == DeviceStatus.online,
      state: newRawState,
      diagnostics: device.diagnostics,
      lastSeen: device.lastSeen,
      rssi: device.rssi,
      battery: device.battery,
    );

    return CapabilityAssembler.assemble(dto, product);
  }

  @override
  DeviceModel updateDeviceStatus(DeviceModel device, bool isOnline) {
    return device.copyWith(
      status: isOnline ? DeviceStatus.online : DeviceStatus.offline,
    );
  }

  @override
  Future<void> updateCapability(String mac, String capabilityId,
      String instance, String action, dynamic value) async {
    // Use the actual action and instance from the capability model
    final payload = {'value': value};

    // Command delivery is HTTP-based; WebSocket is only the realtime response path.
    // Let failures propagate so the provider can roll back its optimistic state.
    await remoteDataSource.sendCommand(mac, action, instance, payload);
  }

  @override
  Future<DeviceModel> claimDevice(String mac, String secretKey, {String? name}) async {
    final dto = await remoteDataSource.claimDevice(mac, secretKey, name: name);
    final product = await getProduct(dto.productId);
    return CapabilityAssembler.assemble(dto, product);
  }

  @override
  Future<DeviceModel> updateDeviceName(String mac, String name) async {
    final dto = await remoteDataSource.updateDeviceName(mac, name);
    final product = await getProduct(dto.productId);
    return CapabilityAssembler.assemble(dto, product);
  }

  @override
  Future<void> unpairDevice(String mac) async {
    await remoteDataSource.unpairDevice(mac);
  }
}
