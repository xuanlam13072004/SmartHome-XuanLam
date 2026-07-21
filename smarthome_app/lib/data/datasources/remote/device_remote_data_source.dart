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
  Future<void> sendCommand(String mac, String action, String instance, Map<String, dynamic> payload);
}

@riverpod
IDeviceRemoteDataSource deviceRemoteDataSource(Ref ref) {
  return DeviceRemoteDataSourceImpl(ref.watch(dioProvider));
}

class DeviceRemoteDataSourceImpl implements IDeviceRemoteDataSource {
  final Dio _dio;

  DeviceRemoteDataSourceImpl(this._dio);

  @override
  Future<List<ProductDto>> getProducts() async {
    final response = await _dio.get<Map<String, dynamic>>('/products');
    if (response.data != null && response.data!['success'] == true) {
      final productsJson = response.data!['products'] as List;
      return productsJson.map((json) => ProductDto.fromJson(json as Map<String, dynamic>)).toList();
    }
    return [];
  }

  @override
  Future<List<DeviceDto>> getDevices() async {
    final response = await _dio.get<Map<String, dynamic>>('/devices');
    if (response.data != null && response.data!['success'] == true) {
      final devicesJson = response.data!['devices'] as List;
      return devicesJson.map((json) => DeviceDto.fromJson(json as Map<String, dynamic>)).toList();
    }
    return [];
  }

  @override
  Future<void> sendCommand(String mac, String action, String instance, Map<String, dynamic> payload) async {
    await _dio.post<dynamic>('/devices/$mac/commands', data: {
      'action': action,
      'instance': instance,
      'payload': payload,
    });
  }
}
