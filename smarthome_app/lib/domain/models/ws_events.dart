import 'dart:convert';

abstract class WsEvent {
  final String event;
  WsEvent(this.event);
}

class AuthSuccessEvent extends WsEvent {
  AuthSuccessEvent() : super('auth_success');
}

class InitialStateEvent extends WsEvent {
  final List<dynamic> rawDevices;
  InitialStateEvent(this.rawDevices) : super('initial_state');
}

class TelemetryEvent extends WsEvent {
  final String mac;
  final Map<String, dynamic> payload;
  final String timestamp;

  TelemetryEvent({
    required this.mac,
    required this.payload,
    required this.timestamp,
  }) : super('telemetry');
}

class DeviceStatusEvent extends WsEvent {
  final String mac;
  final bool isOnline;

  DeviceStatusEvent({
    required this.mac,
    required this.isOnline,
  }) : super('device_status');
}

class CommandStatusEvent extends WsEvent {
  final String mac;
  final Map<String, dynamic> payload;
  final String timestamp;

  CommandStatusEvent({
    required this.mac,
    required this.payload,
    required this.timestamp,
  }) : super('command_status');
}

class ActiveCommandsEvent extends WsEvent {
  final List<dynamic> commands;

  ActiveCommandsEvent(this.commands) : super('active_commands');
}

class UnknownEvent extends WsEvent {
  final String rawData;
  UnknownEvent(this.rawData) : super('unknown');
}

class WsEventParser {
  static WsEvent parse(String rawJson) {
    try {
      final data = jsonDecode(rawJson) as Map<String, dynamic>;
      final event = data['event'];

      switch (event) {
        case 'auth_success':
          return AuthSuccessEvent();
        case 'initial_state':
          return InitialStateEvent(data['devices'] as List<dynamic>? ?? []);
        case 'telemetry':
          return TelemetryEvent(
            mac: data['mac'] as String? ?? '',
            payload: data['payload'] as Map<String, dynamic>? ?? <String, dynamic>{},
            timestamp: data['timestamp'] as String? ?? '',
          );
        case 'device_status':
          // Backend sends: { event: 'device_status', mac, payload: { is_online } }
          final payload = data['payload'] as Map<String, dynamic>? ?? <String, dynamic>{};
          final isOnline = payload['is_online'] as bool? ?? false;
          return DeviceStatusEvent(
            mac: data['mac'] as String? ?? '',
            isOnline: isOnline,
          );
        case 'command_status':
          return CommandStatusEvent(
            mac: data['mac'] as String? ?? '',
            payload: data['payload'] as Map<String, dynamic>? ?? <String, dynamic>{},
            timestamp: data['timestamp'] as String? ?? '',
          );
        case 'active_commands':
          return ActiveCommandsEvent(data['commands'] as List<dynamic>? ?? []);
        default:
          return UnknownEvent(rawJson);
      }
    } catch (e) {
      return UnknownEvent(rawJson);
    }
  }
}
