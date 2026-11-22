import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';
import '../../../core/network/session_events.dart';
import '../../../core/storage/token_storage_provider.dart';
import '../../../data/datasources/remote/auth_remote_data_source_provider.dart';
import '../repositories/auth_repository.dart';
import '../../dashboard/providers/realtime_provider.dart';
import '../../dashboard/providers/devices_provider.dart';
import '../../push/push_notifications.dart';

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
    final subscription = SessionEvents.expired.listen((_) => _onSessionExpired());
    ref.onDispose(subscription.cancel);
    return AuthState.unknown;
  }

  /// The server ended this session (signed out elsewhere, password changed,
  /// account deleted): drop live data and go back to sign-in.
  void _onSessionExpired() {
    if (state != AuthState.authenticated) return;
    _resetSessionState();
    state = AuthState.expired;
  }

  /// Ends the session on this device only, for when the server-side session
  /// is already gone (for example after deleting the account).
  Future<void> signOutLocally() async {
    await ref.read(authRepositoryProvider).clearLocalSession();
    _resetSessionState();
    state = AuthState.unauthenticated;
  }

  void _resetSessionState() {
    ref.read(webSocketClientProvider).disconnect();
    ref.invalidate(devicesProvider);
    ref.invalidate(realtimeRepositoryProvider);
  }

  Future<void> checkAuth() async {
    state = AuthState.checking;
    // Use getValidToken which checks expiry and auto-refreshes if needed
    final token = await ref.read(authRepositoryProvider).getValidToken();
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

  Future<void> register(String email, String password, String fullName) async {
    await ref.read(authRepositoryProvider).register(email, password, fullName);
  }

  Future<void> logout() async {
    // While the session still works: this phone stops receiving the account's pushes.
    await ref.read(pushNotificationsProvider).stop(signedIn: true);
    try {
      await ref.read(authRepositoryProvider).logout();
    } catch (_) {}
    
    _resetSessionState();
    state = AuthState.unauthenticated;
  }
}
