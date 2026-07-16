import 'dart:async';
import 'dart:convert';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:flutter/foundation.dart';
import '../../features/auth/repositories/auth_repository.dart';

enum ConnectionStatus {
  disconnected,
  connecting,
  authenticating,
  connected,
  reconnecting,
  error,
}

class WebSocketClient {
  final String url;
  final IAuthRepository authRepository;
  
  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _subscription;
  
  // Exponential Backoff parameters
  int _reconnectAttempts = 0;
  final int _maxReconnectDelay = 30000; // 30 seconds
  Timer? _reconnectTimer;
  
  // Ping/Pong parameters
  Timer? _pingTimer;
  Timer? _pongTimeoutTimer;
  final Duration _pingInterval = const Duration(seconds: 20);
  final Duration _pongTimeout = const Duration(seconds: 10);
  
  // Status Stream
  final _statusController = StreamController<ConnectionStatus>.broadcast();
  Stream<ConnectionStatus> get statusStream => _statusController.stream;
  ConnectionStatus _currentStatus = ConnectionStatus.disconnected;

  // Messages Stream
  final _messageController = StreamController<String>.broadcast();
  Stream<String> get messageStream => _messageController.stream;
  
  // Pending Commands
  final List<String> _pendingQueue = [];

  WebSocketClient({required this.url, required this.authRepository}) {
    _updateStatus(ConnectionStatus.disconnected);
  }

  ConnectionStatus get currentStatus => _currentStatus;

  void _updateStatus(ConnectionStatus status) {
    if (_currentStatus != status) {
      _currentStatus = status;
      _statusController.add(status);
    }
  }

  Future<void> connect() async {
    if (_currentStatus == ConnectionStatus.connected || 
        _currentStatus == ConnectionStatus.connecting ||
        _currentStatus == ConnectionStatus.authenticating) {
      return;
    }
    
    _updateStatus(_reconnectAttempts == 0 ? ConnectionStatus.connecting : ConnectionStatus.reconnecting);
    
    try {
      _channel = WebSocketChannel.connect(Uri.parse(url));
      
      _subscription = _channel!.stream.listen(
        _onMessage,
        onError: _onError,
        onDone: _onDone,
      );
      
      // Send Auth immediately
      await _authenticate();
      
    } catch (e) {
      _onError(e);
    }
  }

  Future<void> _authenticate() async {
    _updateStatus(ConnectionStatus.authenticating);
    try {
      final token = await authRepository.getToken();
      if (token == null) {
        throw Exception('No token available');
      }
      final authMessage = jsonEncode({
        'event': 'auth',
        'payload': {'token': token}
      });
      _channel?.sink.add(authMessage);
    } catch (e) {
      _onError(e);
    }
  }

  void _onMessage(dynamic data) {
    if (data is String) {
      try {
        final decoded = jsonDecode(data);
        final event = decoded['event'];
        
        if (event == 'pong') {
          _handlePong();
          return;
        } else if (event == 'auth_success') {
          _handleAuthSuccess();
          // forward to parser anyway if needed
        }
      } catch (_) {}
      
      _messageController.add(data);
    }
  }

  void _handleAuthSuccess() {
    _updateStatus(ConnectionStatus.connected);
    _reconnectAttempts = 0;
    _startHeartbeat();
    _flushPendingQueue();
  }

  void _handlePong() {
    _pongTimeoutTimer?.cancel();
  }

  void _startHeartbeat() {
    _stopHeartbeat();
    _pingTimer = Timer.periodic(_pingInterval, (timer) {
      _sendPing();
    });
  }
  
  void _stopHeartbeat() {
    _pingTimer?.cancel();
    _pongTimeoutTimer?.cancel();
  }

  void _sendPing() {
    if (_currentStatus != ConnectionStatus.connected) return;
    
    final pingMessage = jsonEncode({'event': 'ping'});
    _channel?.sink.add(pingMessage);
    
    _pongTimeoutTimer?.cancel();
    _pongTimeoutTimer = Timer(_pongTimeout, () {
      debugPrint('❌ Ping timeout. Reconnecting...');
      _reconnect();
    });
  }

  void sendRaw(String data) {
    if (_currentStatus == ConnectionStatus.connected) {
      _channel?.sink.add(data);
    } else {
      // Enqueue
      _pendingQueue.add(data);
    }
  }

  void _flushPendingQueue() {
    for (final data in _pendingQueue) {
      _channel?.sink.add(data);
    }
    _pendingQueue.clear();
  }

  void _onError(dynamic error) {
    debugPrint('❌ WebSocket Error: $error');
    if (_currentStatus != ConnectionStatus.reconnecting) {
      _updateStatus(ConnectionStatus.error);
    }
    _reconnect();
  }

  void _onDone() {
    debugPrint('🔌 WebSocket connection closed');
    _reconnect();
  }

  void _reconnect() {
    _stopHeartbeat();
    _subscription?.cancel();
    _channel?.sink.close();
    
    _updateStatus(ConnectionStatus.disconnected);

    final delay = (1000 * (1 << _reconnectAttempts)).clamp(1000, _maxReconnectDelay);
    _reconnectAttempts++;
    
    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(Duration(milliseconds: delay), () {
      connect();
    });
  }

  void disconnect() {
    _reconnectTimer?.cancel();
    _stopHeartbeat();
    _subscription?.cancel();
    _channel?.sink.close();
    _updateStatus(ConnectionStatus.disconnected);
    _reconnectAttempts = 0;
  }
}
