import 'package:dio/dio.dart';

import '../../../core/network/session_events.dart';
import '../../../core/network/token_refresh_mutex.dart';
import '../../../core/storage/token_storage.dart';
import '../../../data/datasources/remote/auth_remote_data_source.dart';

abstract class IAuthRepository {
  Future<void> login(String email, String password);
  Future<void> register(String email, String password, String fullName);
  Future<String> reauthenticate(String password);
  Future<void> logout();
  Future<String?> getToken();

  /// Attempts to get a valid access token, refreshing if needed.
  /// Returns null if refresh also fails (user must re-login).
  Future<String?> getValidToken();

  /// Forgets the local session after the server ended it and tells the app.
  Future<void> expireSession();

  /// Clears local tokens without calling the server (the session no longer exists).
  Future<void> clearLocalSession();
}

class ApiAuthRepository implements IAuthRepository {
  final IAuthRemoteDataSource remoteDataSource;
  final ITokenStorage tokenStorage;

  ApiAuthRepository({
    required this.remoteDataSource,
    required this.tokenStorage,
  });

  @override
  Future<void> login(String email, String password) async {
    final response = await remoteDataSource.login(email, password);
    final accessToken = response['access_token'] as String?;
    final refreshToken = response['refresh_token'] as String?;
    final sessionId = response['session_id'] as String?;
    final user = response['user'] as Map<String, dynamic>?;

    if (accessToken != null && refreshToken != null && sessionId != null) {
      await tokenStorage.saveTokens(
        accessToken: accessToken,
        refreshToken: refreshToken,
        sessionId: sessionId,
      );
      // The profile itself is always read from the server (GET /me).
      if (user != null && user['id'] != null) {
        await tokenStorage.saveUserId(user['id'] as String);
      }
    } else {
      throw Exception('Invalid login response');
    }
  }

  @override
  Future<void> register(String email, String password, String fullName) async {
    await remoteDataSource.register(email, password, fullName);
  }

  @override
  Future<String> reauthenticate(String password) {
    return remoteDataSource.reauthenticate(password);
  }

  @override
  Future<void> logout() async {
    final refreshToken = await tokenStorage.getRefreshToken();
    final sessionId = await tokenStorage.getSessionId();
    if (refreshToken != null && sessionId != null) {
      try {
        await remoteDataSource.logout(sessionId, refreshToken);
      } catch (_) {}
    }
    await tokenStorage.clearTokens();
  }

  @override
  Future<void> expireSession() async {
    await tokenStorage.clearTokens();
    SessionEvents.notifyExpired();
  }

  @override
  Future<void> clearLocalSession() => tokenStorage.clearTokens();

  @override
  Future<String?> getToken() async {
    return await tokenStorage.getAccessToken();
  }

  @override
  Future<String?> getValidToken() async {
    // First try existing token
    final token = await tokenStorage.getAccessToken();
    if (token == null) return null;

    // Simple JWT expiry check (decode payload without verification)
    if (_isTokenExpired(token)) {
      // Attempt refresh
      return await _refreshToken();
    }

    return token;
  }

  /// Attempt to refresh the access token. Returns new token or null.
  Future<String?> _refreshToken() async {
    final refreshToken = await tokenStorage.getRefreshToken();
    final sessionId = await tokenStorage.getSessionId();

    if (refreshToken == null || sessionId == null) return null;

    var expired = false;
    final success = await TokenRefreshMutex.run(() async {
      try {
        final response =
            await remoteDataSource.refresh(sessionId, refreshToken);
        final newAccessToken = response['access_token'] as String?;
        final newRefreshToken = response['refresh_token'] as String?;
        final newSessionId = response['session_id'] as String?;

        if (newAccessToken != null &&
            newRefreshToken != null &&
            newSessionId != null) {
          await tokenStorage.saveTokens(
            accessToken: newAccessToken,
            refreshToken: newRefreshToken,
            sessionId: newSessionId,
          );
          return true;
        }
      } on DioException catch (e) {
        // Only a rejected session ends it; a network error is temporary.
        expired = e.response?.statusCode == 401;
      } catch (_) {}
      return false;
    });

    if (expired) await expireSession();
    return success ? tokenStorage.getAccessToken() : null;
  }

  /// Simple JWT expiry check — decode base64 payload without verification.
  bool _isTokenExpired(String token) {
    try {
      final parts = token.split('.');
      if (parts.length != 3) return true;

      // Add padding if needed
      String payload = parts[1];
      switch (payload.length % 4) {
        case 2:
          payload += '==';
          break;
        case 3:
          payload += '=';
          break;
      }

      final decoded = String.fromCharCodes(
        Uri.parse('data:;base64,$payload').data!.contentAsBytes(),
      );

      // Simple regex to find exp claim
      final expMatch = RegExp(r'"exp"\s*:\s*(\d+)').firstMatch(decoded);
      if (expMatch == null) return true;

      final exp = int.parse(expMatch.group(1)!);
      final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;

      // Consider expired 30 seconds before actual expiry
      return now >= (exp - 30);
    } catch (_) {
      return true; // Malformed tokens must never be treated as authenticated.
    }
  }
}
