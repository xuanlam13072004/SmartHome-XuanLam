import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/dio_provider.dart';
import '../../../domain/models/device_event_model.dart';

final deviceEventRemoteDataSourceProvider =
    Provider.autoDispose<DeviceEventRemoteDataSource>((ref) {
  return DeviceEventRemoteDataSource(ref.watch(dioProvider));
});

class DeviceEventRemoteDataSource {
  const DeviceEventRemoteDataSource(this._dio);

  final Dio _dio;

  Future<List<DeviceEventModel>> getEvents(
    String mac, {
    int limit = 50,
  }) async {
    final normalized = mac.trim().toUpperCase();
    final response = await _dio.get<Map<String, dynamic>>(
      '/devices/${Uri.encodeComponent(normalized)}/events',
      queryParameters: {'limit': limit},
    );
    final rawEvents = response.data?['events'];
    if (rawEvents is! List) return const [];
    return rawEvents
        .whereType<Map<String, dynamic>>()
        .map(DeviceEventModel.fromJson)
        .toList(growable: false);
  }
}
