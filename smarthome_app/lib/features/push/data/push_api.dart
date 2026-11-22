import 'package:dio/dio.dart';

/// This phone's push registration (`/me/push-tokens`), tied to the session.
class PushApi {
  PushApi(this._dio);

  final Dio _dio;

  /// Returns whether the server can send push notifications at all.
  Future<bool> register(String token, String platform) async {
    final response = await _dio.put<Map<String, dynamic>>(
      '/me/push-tokens',
      data: {'token': token, 'platform': platform},
    );
    return response.data?['push_enabled'] == true;
  }

  Future<void> remove(String token) async {
    await _dio.delete<void>('/me/push-tokens', data: {'token': token});
  }

  /// Sends "Thông báo thử" to the account's phones; returns how many got it.
  Future<int> test() async {
    final response = await _dio.post<Map<String, dynamic>>('/me/push-tokens/test');
    return (response.data?['sent'] as num?)?.toInt() ?? 0;
  }
}
