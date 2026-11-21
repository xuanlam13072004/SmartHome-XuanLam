/// Notification center and activity history data.
library;

Map<String, dynamic> _map(Object? value) =>
    value is Map ? Map<String, dynamic>.from(value) : <String, dynamic>{};

/// A warning or critical event of a device I can see, or a message one of my
/// automations sent me (GET /me/notifications).
class AppNotification {
  const AppNotification({
    required this.id,
    required this.at,
    required this.deviceMac,
    required this.deviceName,
    required this.eventName,
    required this.severity,
    required this.category,
    required this.data,
    required this.unread,
    this.kind = 'device_event',
    this.title,
    this.body,
    this.automationId,
  });

  /// device_event · automation · security
  final String kind;

  /// An automation's name and message (kind `automation`), or a security
  /// notice such as the voice lock (kind `security`).
  final String? title;
  final String? body;
  final String? automationId;

  bool get fromAutomation => kind == 'automation';

  bool get fromSecurity => kind == 'security';

  final String id;
  final DateTime at;
  final String deviceMac;
  final String deviceName;
  final String eventName;
  final String severity;
  final String category;
  final Map<String, dynamic> data;
  final bool unread;

  bool get critical => severity == 'critical';

  factory AppNotification.fromJson(Map<String, dynamic> json) {
    final device = _map(json['device']);
    return AppNotification(
      id: json['id'] as String,
      at: DateTime.parse(json['at'] as String).toLocal(),
      deviceMac: device['mac']?.toString() ?? '',
      deviceName: device['name']?.toString() ?? '',
      eventName: json['event_name']?.toString() ?? '',
      severity: json['severity']?.toString() ?? 'warning',
      category: json['category']?.toString() ?? 'device',
      data: _map(json['data']),
      unread: json['unread'] == true,
      kind: json['kind']?.toString() ?? 'device_event',
      title: json['title']?.toString(),
      body: json['body']?.toString(),
      automationId: json['automation_id']?.toString(),
    );
  }
}

/// Something I did (GET /me/activity).
class ActivityItem {
  const ActivityItem({
    required this.kind,
    required this.id,
    required this.at,
    required this.action,
    required this.label,
    required this.status,
    required this.reasonCode,
    required this.deviceMac,
    required this.deviceName,
    required this.metadata,
  });

  /// `operation` (a device command) or `audit` (account, device or sharing change).
  final String kind;
  final String id;
  final DateTime at;
  final String action;
  final String? label;
  final String? status;
  final String? reasonCode;
  final String? deviceMac;
  final String? deviceName;
  final Map<String, dynamic> metadata;

  factory ActivityItem.fromJson(Map<String, dynamic> json) {
    final device = json['device'] is Map ? _map(json['device']) : null;
    return ActivityItem(
      kind: json['kind']?.toString() ?? 'audit',
      id: json['id']?.toString() ?? '',
      at: DateTime.parse(json['at'] as String).toLocal(),
      action: json['action']?.toString() ?? '',
      label: json['label']?.toString(),
      status: json['status']?.toString(),
      reasonCode: json['reason_code']?.toString(),
      deviceMac: device?['mac']?.toString(),
      deviceName: device?['name']?.toString(),
      metadata: _map(json['metadata']),
    );
  }
}

class CursorPage<T> {
  const CursorPage(this.items, this.nextCursor);

  final List<T> items;
  final String? nextCursor;
}

class AccountBadges {
  const AccountBadges({required this.notifications, required this.invites});

  static const empty = AccountBadges(notifications: 0, invites: 0);

  final int notifications;
  final int invites;

  int get total => notifications + invites;
}
