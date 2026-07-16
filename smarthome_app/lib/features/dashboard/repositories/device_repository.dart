import '../../../domain/models/device_model.dart';
import '../../../domain/models/product_model.dart';
import '../../../data/datasources/remote/device_remote_data_source.dart';
import '../../../domain/mappers/capability_assembler.dart';
import '../../../domain/mappers/product_mapper.dart';
import '../../../core/network/websocket_client.dart';
import 'dart:async';

abstract class IDeviceRepository {
  Future<List<DeviceModel>> getDevices();
  Future<void> updateCapability(String deviceId, String capabilityId, dynamic value);
  Future<ProductModel?> getProduct(String productId);
  void dispose();
}

class ApiDeviceRepository implements IDeviceRepository {
  final IDeviceRemoteDataSource remoteDataSource;
  final WebSocketClient webSocketClient;
  
  // In-memory cache for Product Catalog
  List<ProductModel>? _cachedProducts;
  
  // Pending Command Queue
  final List<Map<String, dynamic>> _pendingCommands = [];
  StreamSubscription<ConnectionStatus>? _wsStatusSub;

  ApiDeviceRepository(this.remoteDataSource, this.webSocketClient) {
    _wsStatusSub = webSocketClient.statusStream.listen((status) {
      if (status == ConnectionStatus.connected) {
        _flushPendingCommands();
      }
    });
  }

  void _flushPendingCommands() async {
    if (_pendingCommands.isEmpty) return;
    
    final queue = List<Map<String, dynamic>>.from(_pendingCommands);
    _pendingCommands.clear();

    for (final cmd in queue) {
      try {
        await remoteDataSource.sendCommand(
          cmd['deviceId'] as String,
          cmd['action'] as String,
          cmd['instance'] as String,
          cmd['payload'] as Map<String, dynamic>,
        );
      } catch (e) {
        // If it fails again, re-queue
        _pendingCommands.add(cmd);
      }
    }
  }

  @override
  void dispose() {
    _wsStatusSub?.cancel();
  }

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
  Future<void> updateCapability(String deviceId, String capabilityId, dynamic value) async {
    // Backend endpoint: /devices/:mac/commands
    final action = 'set_$capabilityId';
    final payload = {'value': value};
    
    if (webSocketClient.currentStatus != ConnectionStatus.connected) {
      _pendingCommands.add({
        'deviceId': deviceId,
        'action': action,
        'instance': 'default',
        'payload': payload,
      });
      return;
    }

    try {
      await remoteDataSource.sendCommand(deviceId, action, 'default', payload);
    } catch (e) {
      _pendingCommands.add({
        'deviceId': deviceId,
        'action': action,
        'instance': 'default',
        'payload': payload,
      });
    }
  }
}
