import '../../../core/storage/token_storage.dart';
import '../../../data/datasources/remote/auth_remote_data_source.dart';

abstract class IAuthRepository {
  Future<void> login(String email, String password);
  Future<void> register(String username, String email, String password, String fullName);
  Future<void> logout();
  Future<String?> getToken();
  
  // Future methods for scalability
  // Future<void> loginWithGoogle();
  // Future<void> loginWithApple();
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
      if (user != null && user['id'] != null) {
        await tokenStorage.saveUserId(user['id'] as String);
      }
    } else {
      throw Exception('Invalid login response');
    }
  }

  @override
  Future<void> register(String username, String email, String password, String fullName) async {
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
}
