import '../../../domain/models/device_model.dart';
import '../../../domain/models/product_model.dart';
import '../../../data/datasources/remote/device_remote_data_source.dart';
import '../../../data/models/dto/device_dto.dart';
import '../../../domain/mappers/capability_assembler.dart';
import '../../../domain/mappers/product_mapper.dart';
import '../../../core/widgets/indicators/status_badge.dart' show DeviceStatus;
import '../models/capability_model.dart';
import '../../../domain/models/device_topology.dart';

abstract class IDeviceRepository {
  Future<List<DeviceModel>> getDevices();
  Future<void> updateCapability(
      String mac, CapabilityModel capability, dynamic value,
      {String? reauthToken});
  Future<DeviceModel> claimDevice(String mac, String secretKey, {String? name});
  Future<DeviceModel> updateDeviceName(String mac, String name);
  Future<void> unpairDevice(String mac);
  Future<ProductModel?> getProduct(String productId);
  Future<Map<String, dynamic>> createResourceSession(
      String mac, DeviceResourceDefinition resource,
      {String? reauthToken});
  Future<Map<String, dynamic>> replaceCredential(
      String mac, DeviceCredentialDefinition credential, String material,
      {String? reauthToken});

  /// Assemble a DeviceModel from raw WS JSON data.
  Future<DeviceModel> assembleFromWsJson(Map<String, dynamic> rawJson);

  /// Merge realtime shadow state into the authoritative REST device list.
  Future<List<DeviceModel>> mergeInitialState(
    List<DeviceModel> restDevices,
    List<dynamic> rawDevices,
  );

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
  Future<List<DeviceModel>> mergeInitialState(
    List<DeviceModel> restDevices,
    List<dynamic> rawDevices,
  ) async {
    final rawByMac = <String, Map<String, dynamic>>{};
    for (final raw in rawDevices) {
      if (raw is! Map) continue;
      final json = Map<String, dynamic>.from(raw);
      final mac = json['mac']?.toString().toUpperCase() ?? '';
      if (mac.isNotEmpty) rawByMac[mac] = json;
    }

    return Future.wait(restDevices.map((device) async {
      final realtime = rawByMac[device.mac];
      if (realtime == null) return device;

      // Membership and permissions come from PostgreSQL through REST. They
      // must not be downgraded by an old/eventually-consistent Mongo snapshot.
      final merged = Map<String, dynamic>.from(realtime)
        ..['mac'] = device.mac
        ..['owner_id'] = device.ownerId
        ..['name'] = device.name
        ..['product_id'] = device.productId
        ..['permissions'] = device.permissions
        ..['role'] = device.membershipRole
        ..['is_active'] = true
        ..['network_id'] = device.topology?.networkId
        ..['join_rank'] = device.topology?.joinRank
        ..['topology_role'] = device.topology?.role.name
        ..['topology_epoch'] = device.topology?.epoch
        ..['topology_state'] = _topologyStateWire(device.topology?.state)
        ..['active_hub_mac'] = device.topology?.activeHubMac
        ..['transport_mode'] =
            _transportModeWire(device.topology?.transportMode)
        ..['last_transport_change'] = device.topology?.lastTransportChange;

      return assembleFromWsJson(merged);
    }));
  }

  @override
  Future<DeviceModel> mergeDeviceTelemetry(
      DeviceModel device, Map<String, dynamic> newPayload) async {
    final incomingVersion = _toInt(newPayload['state_version']) ?? 0;
    if (incomingVersion <= device.stateVersion) return device;
    final newInstances = _deepMerge(
      device.instances,
      _map(newPayload['instances']),
    );
    final newDiagnostics = _deepMerge(
      device.diagnostics,
      _map(newPayload['diagnostics']),
    );

    final product = await getProduct(device.productId);

    final dto = DeviceDto(
      mac: device.mac,
      ownerId: device.ownerId,
      name: device.name,
      productId: device.productId,
      isActive: true,
      isOnline: device.status == DeviceStatus.online,
      catalogRevision: product?.catalogRevision ?? 0,
      stateVersion: incomingVersion,
      instances: newInstances,
      diagnostics: newDiagnostics,
      permissions: device.permissions,
      membershipRole: device.membershipRole,
      lastSeen: device.lastSeen,
      networkId: device.topology?.networkId,
      joinRank: device.topology?.joinRank,
      topologyRole: device.topology?.role.name,
      topologyEpoch: device.topology?.epoch,
      topologyState: switch (device.topology?.state) {
        DeviceTopologyState.degradedDirect => 'degraded_direct',
        DeviceTopologyState.stable => 'stable',
        DeviceTopologyState.electing => 'electing',
        DeviceTopologyState.empty => 'empty',
        _ => null,
      },
      activeHubMac: device.topology?.activeHubMac,
      transportMode: switch (device.topology?.transportMode) {
        DeviceTransportMode.directFallback => 'direct_fallback',
        DeviceTransportMode.hub => 'hub',
        DeviceTransportMode.relay => 'relay',
        DeviceTransportMode.offline => 'offline',
        _ => null,
      },
      lastTransportChange: device.topology?.lastTransportChange,
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
      String mac, CapabilityModel capability, dynamic value,
      {String? reauthToken}) async {
    final operation = capability.resolveOperation(value);
    final input = operation.inputNames.isEmpty
        ? <String, dynamic>{}
        : <String, dynamic>{operation.inputNames.single: value};

    await remoteDataSource.createOperation(
      mac,
      capability.instance,
      operation.operationName,
      input,
      expectedStateVersion: capability.properties['state_version'] as int?,
      idempotencyKey:
          '${DateTime.now().microsecondsSinceEpoch}-${capability.instance}-${operation.operationName}',
      reauthToken: reauthToken,
    );
  }

  @override
  Future<Map<String, dynamic>> createResourceSession(
    String mac,
    DeviceResourceDefinition resource, {
    String? reauthToken,
  }) =>
      remoteDataSource.createResourceSession(
        mac,
        resource.instanceId,
        resource.definition.id,
        reauthToken: reauthToken,
      );

  @override
  Future<Map<String, dynamic>> replaceCredential(
    String mac,
    DeviceCredentialDefinition credential,
    String material, {
    String? reauthToken,
  }) =>
      remoteDataSource.replaceCredential(
        mac,
        credential.instanceId,
        credential.definition.id,
        material,
        reauthToken: reauthToken,
      );

  static Map<String, dynamic> _map(dynamic value) =>
      value is Map ? Map<String, dynamic>.from(value) : <String, dynamic>{};

  static int? _toInt(dynamic value) {
    if (value is num) return value.toInt();
    return int.tryParse(value?.toString() ?? '');
  }

  static String? _topologyStateWire(DeviceTopologyState? state) =>
      switch (state) {
        DeviceTopologyState.degradedDirect => 'degraded_direct',
        DeviceTopologyState.stable => 'stable',
        DeviceTopologyState.electing => 'electing',
        DeviceTopologyState.empty => 'empty',
        _ => null,
      };

  static String? _transportModeWire(DeviceTransportMode? mode) =>
      switch (mode) {
        DeviceTransportMode.directFallback => 'direct_fallback',
        DeviceTransportMode.hub => 'hub',
        DeviceTransportMode.relay => 'relay',
        DeviceTransportMode.offline => 'offline',
        _ => null,
      };

  static Map<String, dynamic> _deepMerge(
    Map<String, dynamic> current,
    Map<String, dynamic> patch,
  ) {
    final result = Map<String, dynamic>.from(current);
    for (final entry in patch.entries) {
      final existing = result[entry.key];
      if (existing is Map && entry.value is Map) {
        result[entry.key] = _deepMerge(
          Map<String, dynamic>.from(existing),
          Map<String, dynamic>.from(entry.value as Map),
        );
      } else {
        result[entry.key] = entry.value;
      }
    }
    return result;
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
