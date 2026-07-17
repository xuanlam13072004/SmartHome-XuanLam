import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';
import '../../../core/storage/token_storage_provider.dart';
import '../../../data/datasources/remote/auth_remote_data_source_provider.dart';
import '../repositories/auth_repository.dart';
import '../../dashboard/providers/realtime_provider.dart';
import '../../dashboard/providers/devices_provider.dart';

part 'auth_provider.g.dart';

enum AuthState {
  unknown,
  checking,
  authenticated,
  unauthenticated,
  refreshing,
  expired,
}

@Riverpod(keepAlive: true)
IAuthRepository authRepository(Ref ref) {
  final remoteDataSource = ref.watch(authRemoteDataSourceProvider);
  final tokenStorage = ref.watch(tokenStorageProvider);
  return ApiAuthRepository(
    remoteDataSource: remoteDataSource,
    tokenStorage: tokenStorage,
  );
}

@Riverpod(keepAlive: true)
class AuthController extends _$AuthController {
  @override
  AuthState build() {
    return AuthState.unknown;
  }

  Future<void> checkAuth() async {
    state = AuthState.checking;
    final token = await ref.read(authRepositoryProvider).getToken();
    if (token != null) {
      state = AuthState.authenticated;
    } else {
      state = AuthState.unauthenticated;
    }
  }

  Future<void> login(String email, String password) async {
    try {
      await ref.read(authRepositoryProvider).login(email, password);
      state = AuthState.authenticated;
    } catch (e) {
      state = AuthState.unauthenticated;
      rethrow;
    }
  }

  Future<void> register(String username, String email, String password, String fullName) async {
    await ref.read(authRepositoryProvider).register(username, email, password, fullName);
  }

  Future<void> logout() async {
    try {
      await ref.read(authRepositoryProvider).logout();
    } catch (_) {}
    
    // Clear WebSocket
    ref.read(webSocketClientProvider).disconnect();
    
    // Invalidate state to clear caches
    ref.invalidate(devicesProvider);
    ref.invalidate(realtimeRepositoryProvider);
    
    state = AuthState.unauthenticated;
  }
}
