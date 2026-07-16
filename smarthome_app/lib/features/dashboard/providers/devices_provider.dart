import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';
import '../models/device_mock.dart';
import '../repositories/device_repository.dart';

part 'devices_provider.g.dart';

@riverpod
IDeviceRepository deviceRepository(Ref ref) {
  return MockDeviceRepository();
}

@riverpod
class Devices extends _$Devices {
  @override
  FutureOr<List<DeviceMock>> build() async {
    return ref.read(deviceRepositoryProvider).getDevices();
  }

  Future<void> updateCapability(String deviceId, String capabilityId, dynamic value) async {
    final previousState = state;
    
    // Optimistic Update: Cập nhật UI ngay lập tức
    if (state.value != null) {
      final devices = List.of(state.value!);
      final deviceIndex = devices.indexWhere((d) => d.id == deviceId);
      if (deviceIndex != -1) {
        final device = devices[deviceIndex];
        final capIndex = device.capabilities.indexWhere((c) => c.id == capabilityId);
        if (capIndex != -1) {
          final updatedCap = device.capabilities[capIndex].copyWith(value: value);
          final newCapabilities = List.of(device.capabilities);
          newCapabilities[capIndex] = updatedCap;
          
          devices[deviceIndex] = device.copyWith(capabilities: newCapabilities);
          state = AsyncData(devices); // Cập nhật lại UI lập tức
        }
      }
    }

    try {
      // Gọi xuống Backend/Mock Repository
      await ref.read(deviceRepositoryProvider).updateCapability(deviceId, capabilityId, value);
    } catch (e) {
      // Revert lại state cũ nếu có lỗi
      state = previousState;
    }
  }
}
