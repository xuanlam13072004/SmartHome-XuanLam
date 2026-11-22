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

class OperationStatusEvent extends WsEvent {
  final String mac;
  final Map<String, dynamic> payload;
  final String timestamp;

  OperationStatusEvent({
    required this.mac,
    required this.payload,
    required this.timestamp,
  }) : super('operation_status');
}

class CredentialStatusEvent extends WsEvent {
  final String mac;
  final Map<String, dynamic> payload;
  final String timestamp;

  CredentialStatusEvent({
    required this.mac,
    required this.payload,
    required this.timestamp,
  }) : super('credential_status');
}

class DeviceEventEvent extends WsEvent {
  final String mac;
  final Map<String, dynamic> payload;
  final String timestamp;

  DeviceEventEvent({
    required this.mac,
    required this.payload,
    required this.timestamp,
  }) : super('device_event');
}

class ActiveOperationsEvent extends WsEvent {
  final List<dynamic> operations;

  ActiveOperationsEvent(this.operations) : super('active_operations');
}

class TopologyMemberUpdate {
  const TopologyMemberUpdate({
    required this.mac,
    required this.role,
    required this.joinRank,
  });

  final String mac;
  final String role;
  final int joinRank;
}

class TopologyUpdatedEvent extends WsEvent {
  TopologyUpdatedEvent({
    required this.networkId,
    required this.epoch,
    required this.state,
    required this.members,
    required this.timestamp,
    this.activeHubMac,
    this.removedMac,
  }) : super('topology_updated');

  final String networkId;
  final int epoch;
  final String state;
  final String? activeHubMac;
  final List<TopologyMemberUpdate> members;
  final String timestamp;
  final String? removedMac;
}

/// Access to a device was granted to or withdrawn from this account (sharing).
class DeviceAccessEvent extends WsEvent {
  DeviceAccessEvent({required this.mac, required this.granted})
      : super(granted ? 'device_access_granted' : 'device_access_revoked');
  final String mac;
  final bool granted;
}

/// A personal event for this account, e.g. `sharing_invite_received`.
class AccountNotificationEvent extends WsEvent {
  AccountNotificationEvent(super.event, this.data);
  final Map<String, dynamic> data;
}

/// Progress of one of this account's scene runs (`scene_run_updated`).
class SceneRunEvent extends WsEvent {
  SceneRunEvent(this.run) : super('scene_run_updated');
  final Map<String, dynamic> run;
}

/// One of this account's automations fired (`automation_fired`): its new status.
class AutomationFiredEvent extends WsEvent {
  AutomationFiredEvent(this.status) : super('automation_fired');

  /// automation_id, last_triggered_at, last_result, last_run_id, next_run_at
  final Map<String, dynamic> status;
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
            payload:
                data['payload'] as Map<String, dynamic>? ?? <String, dynamic>{},
            timestamp: data['timestamp'] as String? ?? '',
          );
        case 'device_status':
          // Backend sends: { event: 'device_status', mac, payload: { is_online } }
          final payload =
              data['payload'] as Map<String, dynamic>? ?? <String, dynamic>{};
          final isOnline = payload['is_online'] as bool? ?? false;
          return DeviceStatusEvent(
            mac: data['mac'] as String? ?? '',
            isOnline: isOnline,
          );
        case 'operation_status':
          return OperationStatusEvent(
            mac: data['mac'] as String? ?? '',
            payload:
                data['payload'] as Map<String, dynamic>? ?? <String, dynamic>{},
            timestamp: data['timestamp'] as String? ?? '',
          );
        case 'credential_status':
          return CredentialStatusEvent(
            mac: data['mac'] as String? ?? '',
            payload:
                data['payload'] as Map<String, dynamic>? ?? <String, dynamic>{},
            timestamp: data['timestamp'] as String? ?? '',
          );
        case 'device_event':
          return DeviceEventEvent(
            mac: data['mac']?.toString().toUpperCase() ?? '',
            payload: data['payload'] is Map
                ? Map<String, dynamic>.from(data['payload'] as Map)
                : <String, dynamic>{},
            timestamp: data['timestamp']?.toString() ?? '',
          );
        case 'active_operations':
          return ActiveOperationsEvent(
            data['operations'] as List<dynamic>? ?? [],
          );
        case 'topology_updated':
          final rawMembers = data['members'] as List<dynamic>? ?? const [];
          final members = rawMembers
              .whereType<Map<String, dynamic>>()
              .map(
                (member) => TopologyMemberUpdate(
                  mac: member['mac']?.toString().toUpperCase() ?? '',
                  role: member['role']?.toString() ?? '',
                  joinRank: _toInt(member['join_rank']) ?? 0,
                ),
              )
              .where((member) => member.mac.isNotEmpty)
              .toList();
          final change = data['change'] as Map<String, dynamic>?;
          final removedMac = change != null && change['type'] == 'unpair'
              ? change['mac']?.toString().toUpperCase()
              : null;
          return TopologyUpdatedEvent(
            networkId: data['network_id']?.toString() ?? '',
            epoch: _toInt(data['topology_epoch']) ?? 0,
            state: data['topology_state']?.toString() ?? '',
            activeHubMac: data['active_hub_mac']?.toString().toUpperCase(),
            members: members,
            timestamp: data['timestamp']?.toString() ?? '',
            removedMac: removedMac,
          );
        case 'device_access_granted':
        case 'device_access_revoked':
          return DeviceAccessEvent(
            mac: data['mac']?.toString().toUpperCase() ?? '',
            granted: event == 'device_access_granted',
          );
        case 'sharing_invite_received':
        case 'sharing_invite_cancelled':
        case 'sharing_member_joined':
        case 'notification_created':
        case 'payment_updated':
          return AccountNotificationEvent(
            event as String,
            data['data'] is Map ? Map<String, dynamic>.from(data['data'] as Map) : <String, dynamic>{},
          );
        case 'automation_fired':
          final status = data['data'];
          if (status is! Map || status['automation_id'] is! String) return UnknownEvent(rawJson);
          return AutomationFiredEvent(Map<String, dynamic>.from(status));
        case 'scene_run_updated':
          final payload = data['data'];
          final run = payload is Map ? payload['run'] : null;
          if (run is! Map) return UnknownEvent(rawJson);
          return SceneRunEvent(Map<String, dynamic>.from(run));
        default:
          return UnknownEvent(rawJson);
      }
    } catch (e) {
      return UnknownEvent(rawJson);
    }
  }

  static int? _toInt(dynamic value) {
    if (value is num) return value.toInt();
    return int.tryParse(value?.toString() ?? '');
  }
}
