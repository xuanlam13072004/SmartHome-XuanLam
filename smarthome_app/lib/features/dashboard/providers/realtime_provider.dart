import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';
import '../../../core/network/websocket_client.dart';
import '../../../core/config/app_config.dart';
import '../../auth/providers/auth_provider.dart';
import '../repositories/realtime_repository.dart';

part 'realtime_provider.g.dart';

@Riverpod(keepAlive: true)
WebSocketClient webSocketClient(Ref ref) {
  final authRepo = ref.watch(authRepositoryProvider);

  // Convert API baseUrl to WebSocket URL (e.g. http://localhost:3000 -> ws://localhost:3001/ws)
  final uri = Uri.parse(AppConfig.baseUrl);
  final wsHost = uri.host;
  final wsScheme = uri.scheme == 'https' ? 'wss' : 'ws';
  // Real-time service runs on port 3001
  final wsUrl = AppConfig.wsUrl.isNotEmpty
      ? AppConfig.wsUrl
      : '$wsScheme://$wsHost:3001/ws';

  final client = WebSocketClient(url: wsUrl, authRepository: authRepo);
  ref.onDispose(client.dispose);

  // Do NOT auto-connect here. Connection is triggered by auth state change below.
  return client;
}

/// Listens to auth state changes and connects/disconnects WebSocket accordingly.
@Riverpod(keepAlive: true)
void webSocketLifecycle(Ref ref) {
  final authState = ref.watch(authControllerProvider);
  final client = ref.watch(webSocketClientProvider);

  if (authState == AuthState.authenticated) {
    // Only connect if not already connected
    if (client.currentStatus == ConnectionStatus.disconnected ||
        client.currentStatus == ConnectionStatus.error) {
      client.connect();
    }
  } else if (authState == AuthState.unauthenticated) {
    client.disconnect();
  }
}

@Riverpod(keepAlive: true)
IRealtimeRepository realtimeRepository(Ref ref) {
  final client = ref.watch(webSocketClientProvider);
  final repo = RealtimeRepositoryImpl(client);
  ref.onDispose(() => repo.dispose());
  return repo;
}

@riverpod
Stream<ConnectionStatus> connectionStatus(Ref ref) {
  return ref.watch(webSocketClientProvider).statusStream;
}
