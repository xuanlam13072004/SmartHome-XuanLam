import 'dart:async';
import '../../../core/network/websocket_client.dart';
import '../../../domain/models/ws_events.dart';

abstract class IRealtimeRepository {
  Stream<WsEvent> get eventStream;
  Stream<ConnectionStatus> get statusStream;
  void connect();
  void disconnect();
}

class RealtimeRepositoryImpl implements IRealtimeRepository {
  final WebSocketClient _client;
  final _eventController = StreamController<WsEvent>.broadcast();
  StreamSubscription<dynamic>? _sub;

  // Deduplication cache: mac -> last rawState JSON string
  final Map<String, String> _lastStateCache = {};

  RealtimeRepositoryImpl(this._client) {
    _sub = _client.messageStream.listen(_onRawMessage);
  }

  void _onRawMessage(String rawJson) {
    final event = WsEventParser.parse(rawJson);
    
    // Deduplication Logic
    if (event is TelemetryEvent) {
      final stateStr = event.payload.toString(); 
      if (_lastStateCache[event.mac] == stateStr) {
        return; // Ignore duplicate
      }
      _lastStateCache[event.mac] = stateStr;
    }

    _eventController.add(event);
  }

  @override
  Stream<WsEvent> get eventStream => _eventController.stream;

  @override
  Stream<ConnectionStatus> get statusStream => _client.statusStream;

  @override
  void connect() {
    _client.connect();
  }

  @override
  void disconnect() {
    _client.disconnect();
    _lastStateCache.clear();
  }

  void dispose() {
    _sub?.cancel();
    _eventController.close();
  }
}
