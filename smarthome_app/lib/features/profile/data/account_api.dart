import 'package:dio/dio.dart';

import 'account_models.dart';

/// Account center endpoints (`/me…`). Every call acts on the signed-in user.
class AccountApi {
  AccountApi(this._dio);

  final Dio _dio;

  Future<AccountOverview> fetchOverview() async {
    final response = await _dio.get<Map<String, dynamic>>('/me');
    return AccountOverview.fromJson(response.data!);
  }

  Future<AccountProfile> updateProfile({required String fullName}) async {
    final response = await _dio.patch<Map<String, dynamic>>(
      '/me',
      data: {'full_name': fullName},
    );
    return AccountProfile.fromJson(response.data!['user'] as Map<String, dynamic>);
  }

  /// Changes the password. Other sessions are signed out; this one continues
  /// with the returned access token.
  Future<({String accessToken, int signedOutSessions})> changePassword({
    required String currentPassword,
    required String newPassword,
  }) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '/me/password',
      data: {'current_password': currentPassword, 'new_password': newPassword},
    );
    final data = response.data!;
    return (
      accessToken: data['access_token'] as String,
      signedOutSessions: (data['signed_out_sessions'] as num?)?.toInt() ?? 0,
    );
  }

  Future<List<LoginSession>> fetchSessions() async {
    final response = await _dio.get<Map<String, dynamic>>('/me/sessions');
    final items = response.data?['sessions'] as List? ?? const [];
    return items.map((item) => LoginSession.fromJson(item as Map<String, dynamic>)).toList();
  }

  Future<void> revokeSession(String sessionId) async {
    await _dio.delete<void>('/me/sessions/${Uri.encodeComponent(sessionId)}');
  }

  Future<int> revokeOtherSessions() async {
    final response = await _dio.post<Map<String, dynamic>>('/me/sessions/revoke-others');
    return (response.data?['signed_out_sessions'] as num?)?.toInt() ?? 0;
  }

  /// Permanently deletes the account (the server refuses while devices are owned).
  Future<void> deleteAccount({required String password}) async {
    await _dio.delete<void>('/me', data: {'password': password});
  }

  /// True when the API Gateway answers its health check.
  Future<bool> isServerReachable() async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        '/health',
        options: Options(extra: {'skipAuth': true}),
      );
      return response.data?['status'] == 'ok';
    } catch (_) {
      return false;
    }
  }
}
