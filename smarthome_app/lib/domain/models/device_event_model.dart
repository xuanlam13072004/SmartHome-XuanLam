class DeviceEventModel {
  const DeviceEventModel({
    required this.eventId,
    required this.deviceId,
    required this.instanceId,
    required this.eventName,
    required this.severity,
    required this.data,
    required this.occurredAt,
    required this.receivedAt,
    this.capabilityId = '',
  });

  final String eventId;
  final String deviceId;
  final String instanceId;
  final String capabilityId;
  final String eventName;
  final String severity;
  final Map<String, dynamic> data;
  final DateTime occurredAt;
  final DateTime receivedAt;

  factory DeviceEventModel.fromJson(Map<String, dynamic> json) {
    final receivedAt = _date(json['received_at']) ?? DateTime.now().toUtc();
    return DeviceEventModel(
      eventId: '${json['event_id'] ?? json['_id'] ?? ''}',
      deviceId: '${json['device_id'] ?? ''}'.toUpperCase(),
      instanceId: '${json['instance_id'] ?? ''}',
      capabilityId: '${json['capability_id'] ?? ''}',
      eventName: '${json['event_name'] ?? ''}',
      severity: '${json['severity'] ?? 'info'}',
      data: json['data'] is Map
          ? Map<String, dynamic>.from(json['data'] as Map)
          : const <String, dynamic>{},
      occurredAt: _date(json['occurred_at']) ?? receivedAt,
      receivedAt: receivedAt,
    );
  }

  static DateTime? _date(dynamic value) {
    if (value is DateTime) return value;
    if (value is Map && value[r'$date'] != null) {
      return DateTime.tryParse('${value[r'$date']}');
    }
    return DateTime.tryParse('${value ?? ''}');
  }
}
