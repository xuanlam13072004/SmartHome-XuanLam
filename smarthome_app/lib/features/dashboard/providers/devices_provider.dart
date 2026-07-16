import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';
import '../../../domain/models/device_model.dart';
import '../repositories/device_repository.dart';
import '../../../data/datasources/remote/device_remote_data_source.dart';

part 'devices_provider.g.dart';

@riverpod
IDeviceRepository deviceRepository(Ref ref) {
  final remoteDataSource = ref.watch(deviceRemoteDataSourceProvider);
  return ApiDeviceRepository(remoteDataSource);
}

@riverpod
class Devices extends _$Devices {
  @override
  FutureOr<List<DeviceModel>> build() async {
    return ref.read(deviceRepositoryProvider).getDevices();
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
