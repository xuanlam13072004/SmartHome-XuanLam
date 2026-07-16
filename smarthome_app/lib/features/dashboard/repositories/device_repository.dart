import '../models/device_mock.dart';

abstract class IDeviceRepository {
  Future<List<DeviceMock>> getDevices();
  Future<void> updateCapability(String deviceId, String capabilityId, dynamic value);
}

class MockDeviceRepository implements IDeviceRepository {
  // Biến tĩnh lưu trữ state giả lập trong RAM để giữ nguyên state khi điều hướng
  final List<DeviceMock> _inMemoryDevices = List.from(DeviceMock.staticDevices);

  @override
  Future<List<DeviceMock>> getDevices() async {
    // Mô phỏng API delay
    await Future<void>.delayed(const Duration(milliseconds: 500));
    return _inMemoryDevices;
  }

  @override
  Future<void> updateCapability(String deviceId, String capabilityId, dynamic value) async {
    // Mô phỏng API delay
    await Future<void>.delayed(const Duration(milliseconds: 300));
    
    final deviceIndex = _inMemoryDevices.indexWhere((d) => d.id == deviceId);
    if (deviceIndex == -1) throw Exception('Device not found');

    final device = _inMemoryDevices[deviceIndex];
    final capIndex = device.capabilities.indexWhere((c) => c.id == capabilityId);
    if (capIndex == -1) throw Exception('Capability not found');

    // Cập nhật giá trị
    final updatedCap = device.capabilities[capIndex].copyWith(value: value);
    final newCapabilities = List.of(device.capabilities);
    newCapabilities[capIndex] = updatedCap;

    _inMemoryDevices[deviceIndex] = device.copyWith(capabilities: newCapabilities);
  }
}
