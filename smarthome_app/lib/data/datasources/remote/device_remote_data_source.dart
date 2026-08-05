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
  Future<Map<String, dynamic>> createOperation(
    String mac,
    String instance,
    String operationName,
    Map<String, dynamic> input, {
    int? expectedStateVersion,
    String? idempotencyKey,
    String? reauthToken,
  });
  Future<DeviceDto> claimDevice(String mac, String secretKey, {String? name});
  Future<Map<String, dynamic>> createResourceSession(
    String mac,
    String instanceId,
    String resourceId, {
    String? reauthToken,
  });
  Future<Map<String, dynamic>> replaceCredential(
    String mac,
    String instanceId,
    String credentialName,
    String material, {
    String? label,
    String? reauthToken,
  });
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
  Future<Map<String, dynamic>> createOperation(
    String mac,
    String instance,
    String operationName,
    Map<String, dynamic> input, {
    int? expectedStateVersion,
    String? idempotencyKey,
    String? reauthToken,
  }) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '/devices/${_macPath(mac)}/operations',
      data: {
        'instance_id': instance,
        'operation_name': operationName,
        'input': input,
        if (expectedStateVersion != null)
          'expected_state_version': expectedStateVersion,
        if (idempotencyKey != null) 'idempotency_key': idempotencyKey,
      },
      options: reauthToken == null
          ? null
          : Options(headers: {'x-reauth-token': reauthToken}),
    );
    return response.data ?? const <String, dynamic>{};
  }

  @override
  Future<Map<String, dynamic>> createResourceSession(
    String mac,
    String instanceId,
    String resourceId, {
    String? reauthToken,
  }) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '/devices/${_macPath(mac)}/resources/'
      '${Uri.encodeComponent(instanceId)}/${Uri.encodeComponent(resourceId)}/sessions',
      data: const <String, dynamic>{},
      options: reauthToken == null
          ? null
          : Options(headers: {'x-reauth-token': reauthToken}),
    );
    final created = Map<String, dynamic>.from(
      response.data?['session'] as Map? ?? const {},
    );
    final sessionId = created['session_id']?.toString();
    if (sessionId == null || sessionId.isEmpty) return created;
    for (var attempt = 0; attempt < 30; attempt++) {
      await Future<void>.delayed(const Duration(milliseconds: 300));
      final statusResponse = await _dio.get<Map<String, dynamic>>(
        '/devices/${_macPath(mac)}/resource-sessions/'
        '${Uri.encodeComponent(sessionId)}',
      );
      final session = Map<String, dynamic>.from(
        statusResponse.data?['session'] as Map? ?? const {},
      );
      final status = session['status']?.toString();
      if (status == 'ready' ||
          status == 'failed' ||
          status == 'expired' ||
          status == 'revoked') {
        return {...session, 'access_token': created['access_token']};
      }
    }
    return created;
  }

  @override
  Future<Map<String, dynamic>> replaceCredential(
    String mac,
    String instanceId,
    String credentialName,
    String material, {
    String? label,
    String? reauthToken,
  }) async {
    final response = await _dio.put<Map<String, dynamic>>(
      '/devices/${_macPath(mac)}/credentials/'
      '${Uri.encodeComponent(instanceId)}/${Uri.encodeComponent(credentialName)}',
      data: {
        'material': material,
        if (label != null) 'label': label,
        'idempotency_key':
            '${DateTime.now().microsecondsSinceEpoch}-$instanceId-$credentialName',
      },
      options: reauthToken == null
          ? null
          : Options(headers: {'x-reauth-token': reauthToken}),
    );
    return response.data ?? const <String, dynamic>{};
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
