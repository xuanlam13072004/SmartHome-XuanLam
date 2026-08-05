import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';
import '../../../domain/models/device_model.dart';
import '../repositories/device_repository.dart';
import '../../../data/datasources/remote/device_remote_data_source.dart';
import 'realtime_provider.dart';
import '../../../domain/models/ws_events.dart';
import 'dart:async';
import '../../../domain/models/device_topology.dart';
import '../models/capability_model.dart';
import '../../../domain/models/product_model.dart';

part 'devices_provider.g.dart';

@Riverpod(keepAlive: true)
IDeviceRepository deviceRepository(Ref ref) {
  final remoteDataSource = ref.watch(deviceRemoteDataSourceProvider);
  final repo = ApiDeviceRepository(remoteDataSource);
  ref.onDispose(() => repo.dispose());
  return repo;
}

@riverpod
class Devices extends _$Devices {
  StreamSubscription<WsEvent>? _realtimeSub;
  final Map<String, TopologyUpdatedEvent> _pendingTopologyEvents = {};

  @override
  FutureOr<List<DeviceModel>> build() async {
    final repo = ref.read(deviceRepositoryProvider);
    final realtimeRepo = ref.watch(realtimeRepositoryProvider);

    _realtimeSub?.cancel();
    _realtimeSub = realtimeRepo.eventStream.listen((event) {
      if (event is InitialStateEvent) {
        _handleInitialState(event);
      } else if (event is TelemetryEvent) {
        _handleTelemetry(event);
      } else if (event is DeviceStatusEvent) {
        _handleDeviceStatus(event);
      } else if (event is TopologyUpdatedEvent) {
        _handleTopologyUpdated(event);
      }
      // Operation status events can be surfaced by a dedicated activity UI.
    });

    ref.onDispose(() => _realtimeSub?.cancel());

    final devices = await repo.getDevices();
    return _applyPendingTopology(devices);
  }

  void _handleInitialState(InitialStateEvent event) async {
    final repo = ref.read(deviceRepositoryProvider);
    final List<DeviceModel> updatedDevices = [];

    for (final raw in event.rawDevices) {
      // Delegate assembly to repository — no DTO imports in provider
      final device = await repo.assembleFromWsJson(raw as Map<String, dynamic>);
      updatedDevices.add(device);
    }

    state = AsyncData(_applyPendingTopology(updatedDevices));
  }

  void _handleTelemetry(TelemetryEvent event) async {
    final currentState = state.value;
    if (currentState == null) return;

    final index = currentState.indexWhere((d) => d.mac == event.mac);
    if (index == -1) return;

    final device = currentState[index];
    final repo = ref.read(deviceRepositoryProvider);

    // Delegate state merge to repository
    final newDevice = await repo.mergeDeviceTelemetry(device, event.payload);

    final newState = List<DeviceModel>.from(currentState);
    newState[index] = newDevice;
    state = AsyncData(newState);
  }

  void _handleDeviceStatus(DeviceStatusEvent event) {
    final currentState = state.value;
    if (currentState == null) return;

    final index = currentState.indexWhere((d) => d.mac == event.mac);
    if (index == -1) return;

    final device = currentState[index];
    final repo = ref.read(deviceRepositoryProvider);

    final newDevice = repo.updateDeviceStatus(device, event.isOnline);

    final newState = List<DeviceModel>.from(currentState);
    newState[index] = newDevice;
    state = AsyncData(newState);
  }

  void _handleTopologyUpdated(TopologyUpdatedEvent event) {
    if (event.networkId.isEmpty) return;
    final pending = _pendingTopologyEvents[event.networkId];
    if (pending != null && event.epoch < pending.epoch) return;
    _pendingTopologyEvents[event.networkId] = event;

    final currentState = state.value;
    if (currentState == null) return;
    state = AsyncData(_applyTopologyEvent(currentState, event));
  }

  List<DeviceModel> _applyPendingTopology(List<DeviceModel> devices) {
    var result = devices;
    final ordered = _pendingTopologyEvents.values.toList()
      ..sort((left, right) => left.epoch.compareTo(right.epoch));
    for (final event in ordered) {
      result = _applyTopologyEvent(result, event);
    }
    return result;
  }

  List<DeviceModel> _applyTopologyEvent(
    List<DeviceModel> devices,
    TopologyUpdatedEvent event,
  ) {
    final members = {
      for (final member in event.members) member.mac: member,
    };
    final removedMac = event.removedMac;
    final topologyState = DeviceTopologyState.fromWire(event.state);

    return devices.where((device) {
      if (removedMac == null || device.mac != removedMac) return true;
      final current = device.topology;
      return current != null &&
          (current.networkId != event.networkId || current.epoch > event.epoch);
    }).map((device) {
      final member = members[device.mac];
      if (member == null) return device;
      final current = device.topology;
      if (current != null &&
          current.networkId == event.networkId &&
          current.epoch > event.epoch) {
        return device;
      }

      final role = DeviceTopologyRole.fromWire(member.role);
      final transportMode = role == DeviceTopologyRole.hub
          ? DeviceTransportMode.hub
          : topologyState == DeviceTopologyState.stable
              ? DeviceTransportMode.relay
              : DeviceTransportMode.directFallback;
      return device.copyWith(
        topology: DeviceTopology(
          networkId: event.networkId,
          role: role,
          epoch: event.epoch,
          state: topologyState,
          transportMode: transportMode,
          joinRank: member.joinRank,
          activeHubMac: event.activeHubMac,
          lastTransportChange: event.timestamp,
        ),
      );
    }).toList();
  }

  Future<void> updateCapability(
      String mac, CapabilityModel capability, dynamic value,
      {String? reauthToken}) async {
    final previousState = state;

    // Optimistic Update: Update UI immediately
    if (state.value != null) {
      final devices = List.of(state.value!);

      state = AsyncData(devices.map((device) {
        if (device.mac == mac) {
          final newCapabilities = device.capabilities.map((cap) {
            if (cap.id == capability.id && cap.instance == capability.instance) {
              return cap.copyWith(value: value);
            }
            return cap;
          }).toList();

          final newRawState = Map<String, dynamic>.from(device.rawState);
          newRawState[capability.id] = value;

          return device.copyWith(
            capabilities: newCapabilities,
            rawState: newRawState,
          );
        }
        return device;
      }).toList());

      try {
        final repo = ref.read(deviceRepositoryProvider);
        final devices = state.value;
        final deviceIndex =
            devices?.indexWhere((item) => item.mac == mac) ?? -1;
        if (deviceIndex < 0) {
          throw StateError('Device $mac not found');
        }

        final device = devices![deviceIndex];
        final capabilityIndex = device.capabilities.indexWhere((item) =>
            item.id == capability.id && item.instance == capability.instance);
        if (capabilityIndex < 0) {
          throw StateError(
              'Capability ${capability.instance}.${capability.id} not found');
        }
        final currentCapability = device.capabilities[capabilityIndex];
        await repo.updateCapability(
          mac,
          currentCapability,
          value,
          reauthToken: reauthToken,
        );
      } catch (e) {
        // Revert to previous state on error
        state = previousState;
        rethrow;
      }
    }
  }

  Future<void> claimDevice(String mac, String secretKey, {String? name}) async {
    final repo = ref.read(deviceRepositoryProvider);
    await repo.claimDevice(mac, secretKey, name: name);
    // Refresh danh sách sau khi claim thành công
    ref.invalidateSelf();
  }

  Future<Map<String, dynamic>> createResourceSession(
    String mac,
    DeviceResourceDefinition resource, {
    String? reauthToken,
  }) =>
      ref.read(deviceRepositoryProvider).createResourceSession(
            mac,
            resource,
            reauthToken: reauthToken,
          );

  Future<Map<String, dynamic>> replaceCredential(
    String mac,
    DeviceCredentialDefinition credential,
    String material, {
    String? reauthToken,
  }) =>
      ref.read(deviceRepositoryProvider).replaceCredential(
            mac,
            credential,
            material,
            reauthToken: reauthToken,
          );

  Future<void> renameDevice(String mac, String name) async {
    final repo = ref.read(deviceRepositoryProvider);
    await repo.updateDeviceName(mac, name);
    // Optimistic Update hoặc Invalidate
    ref.invalidateSelf();
  }

  Future<void> unpairDevice(String mac) async {
    final repo = ref.read(deviceRepositoryProvider);
    await repo.unpairDevice(mac);
    // Xóa khỏi danh sách hiện tại hoặc Invalidate
    ref.invalidateSelf();
  }
}
