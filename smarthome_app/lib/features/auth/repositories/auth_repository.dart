import '../../../core/storage/token_storage.dart';
import '../../../data/datasources/remote/auth_remote_data_source.dart';
import '../../../core/network/token_refresh_mutex.dart';

abstract class IAuthRepository {
  Future<void> login(String email, String password);
  Future<void> register(
      String username, String email, String password, String fullName);
  Future<void> logout();
  Future<String?> getToken();

  /// Attempts to get a valid access token, refreshing if needed.
  /// Returns null if refresh also fails (user must re-login).
  Future<String?> getValidToken();
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
      if (user != null) {
        if (user['id'] != null) {
          await tokenStorage.saveUserId(user['id'] as String);
        }
        // Store user profile info for display in Profile screen
        final fullName = user['full_name'] as String? ?? '';
        final email = user['email'] as String? ?? '';
        final username = user['username'] as String? ?? '';
        await tokenStorage.saveUserProfile(
          fullName: fullName,
          email: email,
          username: username,
        );
      }
    } else {
      throw Exception('Invalid login response');
    }
  }

  @override
  Future<void> register(
      String username, String email, String password, String fullName) async {
    await remoteDataSource.register(username, email, password, fullName);
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
      } catch (_) {
        await tokenStorage.clearTokens();
      }
      return false;
    });

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
      if (expMatch == null) return false;

      final exp = int.parse(expMatch.group(1)!);
      final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;

      // Consider expired 30 seconds before actual expiry
      return now >= (exp - 30);
    } catch (_) {
      return false; // If we can't parse, assume not expired
    }
  }
}
