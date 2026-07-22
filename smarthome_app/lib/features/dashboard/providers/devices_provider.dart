import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';
import '../../../domain/models/device_model.dart';
import '../repositories/device_repository.dart';
import '../../../data/datasources/remote/device_remote_data_source.dart';
import 'realtime_provider.dart';
import '../../../domain/models/ws_events.dart';
import 'dart:async';

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
      }
      // CommandStatusEvent and ActiveCommandsEvent can be handled here
      // when command status UI is implemented
    });

    ref.onDispose(() => _realtimeSub?.cancel());

    return repo.getDevices();
  }

  void _handleInitialState(InitialStateEvent event) async {
    final repo = ref.read(deviceRepositoryProvider);
    final List<DeviceModel> updatedDevices = [];

    for (final raw in event.rawDevices) {
      // Delegate assembly to repository — no DTO imports in provider
      final device = await repo.assembleFromWsJson(raw as Map<String, dynamic>);
      updatedDevices.add(device);
    }

    state = AsyncData(updatedDevices);
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

  Future<void> updateCapability(
      String mac, String capabilityId, dynamic value) async {
    final previousState = state;

    // Optimistic Update: Update UI immediately
    if (state.value != null) {
      final devices = List.of(state.value!);

      state = AsyncData(devices.map((device) {
        if (device.mac == mac) {
          final newCapabilities = device.capabilities.map((cap) {
            if (cap.id == capabilityId) {
              return cap.copyWith(value: value);
            }
            return cap;
          }).toList();

          final newRawState = Map<String, dynamic>.from(device.rawState);
          newRawState[capabilityId] = value;

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
        final capabilityIndex =
            device.capabilities.indexWhere((item) => item.id == capabilityId);
        if (capabilityIndex < 0) {
          throw StateError('Capability $capabilityId not found');
        }
        final capability = device.capabilities[capabilityIndex];
        await repo.updateCapability(mac, capability, value);
      } catch (e) {
        // Revert to previous state on error
        state = previousState;
      }
    }
  }

  Future<void> claimDevice(String mac, String secretKey, {String? name}) async {
    final repo = ref.read(deviceRepositoryProvider);
    await repo.claimDevice(mac, secretKey, name: name);
    // Refresh danh sách sau khi claim thành công
    ref.invalidateSelf();
  }

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
