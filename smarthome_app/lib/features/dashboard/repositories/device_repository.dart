import '../../../domain/models/device_model.dart';
import '../../../domain/models/product_model.dart';
import '../../../data/datasources/remote/device_remote_data_source.dart';
import '../../../data/models/dto/device_dto.dart';
import '../../../domain/mappers/capability_assembler.dart';
import '../../../domain/mappers/product_mapper.dart';
import '../../../core/widgets/indicators/status_badge.dart' show DeviceStatus;
import '../models/capability_model.dart';

abstract class IDeviceRepository {
  Future<List<DeviceModel>> getDevices();
  Future<void> updateCapability(
      String mac, CapabilityModel capability, dynamic value);
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
  Future<void> updateCapability(
      String mac, CapabilityModel capability, dynamic value) async {
    final command = _resolveCommand(capability, value);
    final payload = command.argumentNames.isEmpty
        ? <String, dynamic>{}
        : <String, dynamic>{command.argumentNames.single: value};

    await remoteDataSource.sendCommand(
      mac,
      command.action,
      capability.instance,
      payload,
    );
  }

  CapabilityCommandDescriptor _resolveCommand(
      CapabilityModel capability, dynamic value) {
    final withArgument = capability.commands
        .where((command) => command.argumentNames.length == 1)
        .toList();
    if (withArgument.length == 1) return withArgument.single;

    final zeroArgument = capability.commands
        .where((command) => command.argumentNames.isEmpty)
        .toList();
    if (zeroArgument.isNotEmpty) {
      final desiredTokens = _desiredActionTokens(value);
      for (final command in zeroArgument) {
        final action = command.action.toLowerCase();
        if (desiredTokens.any((token) => action.contains(token))) {
          return command;
        }
      }
      if (zeroArgument.length == 1) return zeroArgument.single;
    }

    throw StateError(
      'No unambiguous command mapping for capability ${capability.id}',
    );
  }

  List<String> _desiredActionTokens(dynamic value) {
    if (value is bool) {
      return value
          ? ['on', 'enable', 'start', 'open', 'lock']
          : ['off', 'disable', 'stop', 'close', 'unlock'];
    }

    final normalized = value.toString().toLowerCase();
    const aliases = {
      'locked': ['lock'],
      'unlocked': ['unlock'],
      'open': ['open'],
      'opened': ['open'],
      'closed': ['close'],
      'opening': ['open'],
      'closing': ['close'],
      'stopped': ['stop'],
    };
    return aliases[normalized] ?? [normalized];
  }

  @override
  Future<DeviceModel> claimDevice(String mac, String secretKey,
      {String? name}) async {
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
