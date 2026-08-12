import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:smarthome_app/core/network/websocket_client.dart';
import 'package:smarthome_app/core/widgets/indicators/status_badge.dart';
import 'package:smarthome_app/domain/models/device_model.dart';
import 'package:smarthome_app/domain/models/device_topology.dart';
import 'package:smarthome_app/domain/models/product_model.dart';
import 'package:smarthome_app/domain/models/ws_events.dart';
import 'package:smarthome_app/features/dashboard/models/capability_model.dart';
import 'package:smarthome_app/features/dashboard/providers/devices_provider.dart';
import 'package:smarthome_app/features/dashboard/providers/realtime_provider.dart';
import 'package:smarthome_app/features/dashboard/repositories/device_repository.dart';
import 'package:smarthome_app/features/dashboard/repositories/realtime_repository.dart';

class _FakeDeviceRepository implements IDeviceRepository {
  _FakeDeviceRepository(this.devices);

  final List<DeviceModel> devices;
  CapabilityModel? lastUpdatedCapability;
  dynamic lastUpdatedValue;

  @override
  Future<List<DeviceModel>> getDevices() async => devices;

  @override
  Future<DeviceModel> assembleFromWsJson(Map<String, dynamic> rawJson) =>
      throw UnsupportedError('Not used by this test');

  @override
  Future<List<DeviceModel>> mergeInitialState(
    List<DeviceModel> restDevices,
    List<dynamic> rawDevices,
  ) async =>
      restDevices;

  @override
  Future<DeviceModel> claimDevice(
    String mac,
    String secretKey, {
    String? name,
  }) =>
      throw UnsupportedError('Not used by this test');

  @override
  void dispose() {}

  @override
  Future<ProductModel?> getProduct(String productId) async => null;

  @override
  Future<Map<String, dynamic>> createResourceSession(
    String mac,
    DeviceResourceDefinition resource, {
    String? reauthToken,
  }) =>
      throw UnsupportedError('Not used by this test');

  @override
  Future<Map<String, dynamic>> replaceCredential(
    String mac,
    DeviceCredentialDefinition credential,
    String material, {
    String? reauthToken,
  }) =>
      throw UnsupportedError('Not used by this test');

  @override
  Future<DeviceModel> mergeDeviceTelemetry(
    DeviceModel device,
    Map<String, dynamic> newPayload,
  ) async =>
      device;

  @override
  Future<void> unpairDevice(String mac) async {}

  @override
  Future<void> updateCapability(
    String mac,
    CapabilityModel capability,
    dynamic value, {
    String? reauthToken,
  }) async {
    lastUpdatedCapability = capability;
    lastUpdatedValue = value;
  }

  @override
  DeviceModel updateDeviceStatus(DeviceModel device, bool isOnline) => device;

  @override
  Future<DeviceModel> updateDeviceName(String mac, String name) =>
      throw UnsupportedError('Not used by this test');
}

class _FakeRealtimeRepository implements IRealtimeRepository {
  final StreamController<WsEvent> _events =
      StreamController<WsEvent>.broadcast(sync: true);

  @override
  Stream<WsEvent> get eventStream => _events.stream;

  @override
  Stream<ConnectionStatus> get statusStream => const Stream.empty();

  void emit(WsEvent event) => _events.add(event);

  Future<void> dispose() => _events.close();

  @override
  void connect() {}

  @override
  void disconnect() {}
}

DeviceModel _deviceAtEpoch(int epoch) => DeviceModel(
      mac: 'AA:BB:CC:DD:EE:FF',
      ownerId: 'owner-1',
      name: 'Topology device',
      productId: 'product-1',
      icon: Icons.lightbulb_outline,
      status: DeviceStatus.online,
      rawState: const {},
      diagnostics: const {},
      capabilities: const [],
      topology: DeviceTopology(
        networkId: 'network-1',
        role: DeviceTopologyRole.hub,
        epoch: epoch,
        state: DeviceTopologyState.stable,
        transportMode: DeviceTransportMode.hub,
        joinRank: 1,
        activeHubMac: 'AA:BB:CC:DD:EE:FF',
      ),
    );

void main() {
  test(
      'device provider preserves the operation selected by a specialized panel',
      () async {
    const fullCapability = CapabilityModel(
      id: 'audible_state',
      type: 'enum',
      name: 'Trạng thái còi',
      value: 'muted',
      instance: 'main_siren',
      properties: {
        'options': ['silent', 'sounding', 'muted'],
        'state_version': 9,
      },
      operations: [
        CapabilityOperationDescriptor(
          operationName: 'mute_siren',
          inputNames: ['duration_seconds'],
        ),
        CapabilityOperationDescriptor(operationName: 'resume_siren'),
      ],
    );
    const selectedCapability = CapabilityModel(
      id: 'audible_state',
      type: 'enum',
      name: 'Trạng thái còi',
      value: 'muted',
      instance: 'main_siren',
      operations: [
        CapabilityOperationDescriptor(operationName: 'resume_siren'),
      ],
    );
    final device = _deviceAtEpoch(5).copyWith(
      capabilities: const [fullCapability],
    );
    final repository = _FakeDeviceRepository([device]);
    final realtime = _FakeRealtimeRepository();
    final container = ProviderContainer(
      overrides: [
        deviceRepositoryProvider.overrideWithValue(repository),
        realtimeRepositoryProvider.overrideWithValue(realtime),
      ],
    );
    final subscription = container.listen(
      devicesProvider,
      (_, __) {},
      fireImmediately: true,
    );
    addTearDown(subscription.close);
    addTearDown(container.dispose);
    addTearDown(realtime.dispose);
    await container.read(devicesProvider.future);

    await container.read(devicesProvider.notifier).updateCapability(
          device.mac,
          selectedCapability,
          'resume',
        );

    expect(
      repository.lastUpdatedCapability?.operations.single.operationName,
      'resume_siren',
    );
    expect(repository.lastUpdatedCapability?.properties['state_version'], 9);
    expect(repository.lastUpdatedValue, 'resume');
    expect(
      container
          .read(devicesProvider)
          .requireValue
          .single
          .capabilities
          .single
          .value,
      'muted',
    );
  });

  test('topology provider fences stale updates and stale unpair events',
      () async {
    final repository = _FakeDeviceRepository([_deviceAtEpoch(5)]);
    final realtime = _FakeRealtimeRepository();
    final container = ProviderContainer(
      overrides: [
        deviceRepositoryProvider.overrideWithValue(repository),
        realtimeRepositoryProvider.overrideWithValue(realtime),
      ],
    );
    final subscription = container.listen(
      devicesProvider,
      (_, __) {},
      fireImmediately: true,
    );
    addTearDown(subscription.close);
    addTearDown(container.dispose);
    addTearDown(realtime.dispose);

    await container.read(devicesProvider.future);

    realtime.emit(
      TopologyUpdatedEvent(
        networkId: 'network-1',
        epoch: 6,
        state: 'electing',
        activeHubMac: null,
        members: const [
          TopologyMemberUpdate(
            mac: 'AA:BB:CC:DD:EE:FF',
            role: 'node',
            joinRank: 1,
          ),
        ],
        timestamp: '2026-07-30T00:00:00.000Z',
      ),
    );
    await pumpEventQueue();

    var devices = container.read(devicesProvider).requireValue;
    expect(devices, hasLength(1));
    expect(devices.single.topology?.epoch, 6);
    expect(
      devices.single.topology?.transportMode,
      DeviceTransportMode.directFallback,
    );

    realtime.emit(
      TopologyUpdatedEvent(
        networkId: 'network-1',
        epoch: 5,
        state: 'empty',
        members: const [],
        timestamp: '2026-07-30T00:00:01.000Z',
        removedMac: 'AA:BB:CC:DD:EE:FF',
      ),
    );
    await pumpEventQueue();

    devices = container.read(devicesProvider).requireValue;
    expect(devices, hasLength(1));
    expect(devices.single.topology?.epoch, 6);

    realtime.emit(
      TopologyUpdatedEvent(
        networkId: 'network-1',
        epoch: 7,
        state: 'empty',
        members: const [],
        timestamp: '2026-07-30T00:00:02.000Z',
        removedMac: 'AA:BB:CC:DD:EE:FF',
      ),
    );
    await pumpEventQueue();

    expect(container.read(devicesProvider).requireValue, isEmpty);
  });
}
