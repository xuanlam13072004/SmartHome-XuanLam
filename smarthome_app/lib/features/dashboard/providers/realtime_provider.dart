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
  
  // Convert API baseUrl to WebSocket URL (e.g. http://10.0.2.2:3000 -> ws://10.0.2.2:3001/ws)
  final uri = Uri.parse(AppConfig.baseUrl);
  final wsHost = uri.host;
  final wsScheme = uri.scheme == 'https' ? 'wss' : 'ws';
  // Real-time service runs on port 3001
  final wsUrl = '$wsScheme://$wsHost:3001/ws';
  
  final client = WebSocketClient(url: wsUrl, authRepository: authRepo);
  ref.onDispose(() => client.disconnect());
  
  // Start connection
  client.connect();
  
  return client;
}

@Riverpod(keepAlive: true)
IRealtimeRepository realtimeRepository(Ref ref) {
  final client = ref.watch(webSocketClientProvider);
  return RealtimeRepositoryImpl(client);
}

@riverpod
Stream<ConnectionStatus> connectionStatus(Ref ref) {
  return ref.watch(webSocketClientProvider).statusStream;
}
