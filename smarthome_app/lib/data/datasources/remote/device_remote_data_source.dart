import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';
import '../../models/dto/device_dto.dart';
import '../../models/dto/product_dto.dart';
import '../../../core/network/dio_provider.dart';

part 'device_remote_data_source.g.dart';

abstract class IDeviceRemoteDataSource {
  Future<List<ProductDto>> getProducts();
  Future<List<DeviceDto>> getDevices();
  Future<void> sendCommand(
      String mac, String action, String instance, Map<String, dynamic> payload);
  Future<DeviceDto> claimDevice(String mac, String secretKey, {String? name});
  Future<DeviceDto> updateDeviceName(String mac, String name);
  Future<void> unpairDevice(String mac);
}

@riverpod
IDeviceRemoteDataSource deviceRemoteDataSource(Ref ref) {
  return DeviceRemoteDataSourceImpl(ref.watch(dioProvider));
}

class DeviceRemoteDataSourceImpl implements IDeviceRemoteDataSource {
  final Dio _dio;

  DeviceRemoteDataSourceImpl(this._dio);

  String _normalizeMac(String mac) => mac.trim().toUpperCase();
  String _macPath(String mac) => Uri.encodeComponent(_normalizeMac(mac));

  @override
  Future<List<ProductDto>> getProducts() async {
    final response = await _dio.get<Map<String, dynamic>>('/products');
    if (response.data != null && response.data!['success'] == true) {
      final productsJson = response.data!['products'] as List;
      return productsJson
          .map((json) => ProductDto.fromJson(json as Map<String, dynamic>))
          .toList();
    }
    return [];
  }

  @override
  Future<List<DeviceDto>> getDevices() async {
    final response = await _dio.get<Map<String, dynamic>>('/devices');
    if (response.data != null && response.data!['success'] == true) {
      final devicesJson = response.data!['devices'] as List;
      return devicesJson
          .map((json) => DeviceDto.fromJson(json as Map<String, dynamic>))
          .toList();
    }
    return [];
  }

  @override
  Future<void> sendCommand(String mac, String action, String instance,
      Map<String, dynamic> payload) async {
    await _dio.post<dynamic>('/devices/${_macPath(mac)}/commands', data: {
      'action': action,
      'instance': instance,
      'payload': payload,
    });
  }

  @override
  Future<DeviceDto> claimDevice(String mac, String secretKey,
      {String? name}) async {
    final data = <String, dynamic>{
      'mac': _normalizeMac(mac),
      'secret_key': secretKey,
    };
    if (name != null && name.isNotEmpty) {
      data['name'] = name;
    }
    final response =
        await _dio.post<Map<String, dynamic>>('/devices/claim', data: data);
    return DeviceDto.fromJson(response.data!['device'] as Map<String, dynamic>);
  }

  @override
  Future<DeviceDto> updateDeviceName(String mac, String name) async {
    final response = await _dio.patch<Map<String, dynamic>>(
      '/devices/${_macPath(mac)}',
      data: {'name': name},
    );
    return DeviceDto.fromJson(response.data!['device'] as Map<String, dynamic>);
  }

  @override
  Future<void> unpairDevice(String mac) async {
    await _dio.delete<dynamic>('/devices/${_macPath(mac)}');
  }
}
