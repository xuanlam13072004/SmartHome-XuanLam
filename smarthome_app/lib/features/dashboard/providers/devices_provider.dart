import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';
import '../../../domain/models/device_model.dart';
import '../repositories/device_repository.dart';
import '../../../data/datasources/remote/device_remote_data_source.dart';
import 'realtime_provider.dart';
import '../../../data/models/dto/device_dto.dart';
import '../../../domain/mappers/capability_assembler.dart';
import '../../../core/widgets/indicators/status_badge.dart';
import '../../../domain/models/ws_events.dart';
import 'dart:async';

part 'devices_provider.g.dart';

@riverpod
IDeviceRepository deviceRepository(Ref ref) {
  final remoteDataSource = ref.watch(deviceRemoteDataSourceProvider);
  final wsClient = ref.watch(webSocketClientProvider);
  final repo = ApiDeviceRepository(remoteDataSource, wsClient);
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
    });

    ref.onDispose(() => _realtimeSub?.cancel());

    return repo.getDevices();
  }

  void _handleInitialState(InitialStateEvent event) async {
    final repo = ref.read(deviceRepositoryProvider);
    final List<DeviceModel> updatedDevices = [];
    
    for (final raw in event.rawDevices) {
      final dto = DeviceDto.fromJson(raw as Map<String, dynamic>);
      final product = await repo.getProduct(dto.productId);
      updatedDevices.add(CapabilityAssembler.assemble(dto, product));
    }
    
    state = AsyncData(updatedDevices);
  }

  void _handleTelemetry(TelemetryEvent event) async {
    final currentState = state.value;
    if (currentState == null) return;
    
    final index = currentState.indexWhere((d) => d.id == event.mac);
    if (index == -1) return;
    
    final device = currentState[index];
    
    // Merge new payload into rawState
    final newRawState = Map<String, dynamic>.from(device.rawState);
    newRawState.addAll(event.payload);
    
    final repo = ref.read(deviceRepositoryProvider);
    final product = await repo.getProduct(device.productId);
    
    final dto = DeviceDto(
      id: device.id,
      ownerId: device.ownerId,
      mac: device.id, // mac == id
      name: device.name,
      productId: device.productId,
      isActive: true, // Assuming active if in list
      isOnline: device.status == DeviceStatus.online,
      state: newRawState,
      diagnostics: device.diagnostics,
    );
    
    final newDevice = CapabilityAssembler.assemble(dto, product);
    
    final newState = List<DeviceModel>.from(currentState);
    newState[index] = newDevice;
    state = AsyncData(newState);
  }

  void _handleDeviceStatus(DeviceStatusEvent event) {
    final currentState = state.value;
    if (currentState == null) return;
    
    final index = currentState.indexWhere((d) => d.id == event.mac);
    if (index == -1) return;
    
    final device = currentState[index];
    
    final newDevice = device.copyWith(status: event.isOnline ? DeviceStatus.online : DeviceStatus.offline);
    
    final newState = List<DeviceModel>.from(currentState);
    newState[index] = newDevice;
    state = AsyncData(newState);
  }

  Future<void> updateCapability(String deviceId, String capabilityId, dynamic value) async {
    final previousState = state;
    
    // Optimistic Update: Cập nhật UI ngay lập tức
    if (state.value != null) {
      final devices = List.of(state.value!);
      
      state = AsyncData(devices.map((device) {
        if (device.id == deviceId) {
          final newCapabilities = device.capabilities.map((cap) {
            if (cap.id == capabilityId) {
              return cap.copyWith(value: value);
            }
            return cap;
          }).toList();

          // Cập nhật giá trị trực tiếp vào rawState để giữ consistency (Tùy chọn)
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
        // Background Update: Gọi xuống Repository (gọi API thật)
        await repo.updateCapability(deviceId, capabilityId, value);
        
        // Bạn có thể trigger refresh nếu muốn lấy lại toàn bộ state từ Server
        // ref.invalidateSelf();
      } catch (e) {
        // Revert lại state cũ nếu có lỗi
        state = previousState;
      }
    }
  }
}
