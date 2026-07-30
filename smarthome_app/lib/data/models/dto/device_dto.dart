class DeviceDto {
  final String mac;
  final String ownerId;
  final String name;
  final String productId;
  final bool isActive;
  final bool isOnline;
  final Map<String, dynamic> state;
  final Map<String, dynamic> diagnostics;
  final String? lastSeen;
  final int? rssi;
  final int? battery;
  final String? networkId;
  final int? joinRank;
  final String? topologyRole;
  final int? topologyEpoch;
  final String? topologyState;
  final String? activeHubMac;
  final String? transportMode;
  final String? lastTransportChange;

  DeviceDto({
    required this.mac,
    required this.ownerId,
    required this.name,
    required this.productId,
    required this.isActive,
    required this.isOnline,
    required this.state,
    required this.diagnostics,
    this.lastSeen,
    this.rssi,
    this.battery,
    this.networkId,
    this.joinRank,
    this.topologyRole,
    this.topologyEpoch,
    this.topologyState,
    this.activeHubMac,
    this.transportMode,
    this.lastTransportChange,
  });

  factory DeviceDto.fromJson(Map<String, dynamic> json) {
    return DeviceDto(
      mac: json['mac'] as String? ?? '',
      ownerId: json['owner_id'] as String? ?? '',
      name: json['name'] as String? ?? '',
      productId: json['product_id'] as String? ?? '',
      isActive: json['is_active'] as bool? ?? true,
      isOnline: json['is_online'] as bool? ?? false,
      state: json['state'] as Map<String, dynamic>? ?? {},
      diagnostics: json['diagnostics'] as Map<String, dynamic>? ?? {},
      lastSeen: json['last_seen'] as String?,
      rssi: (json['rssi'] as num?)?.toInt(),
      battery: (json['battery'] as num?)?.toInt(),
      networkId: json['network_id']?.toString(),
      joinRank: _toInt(json['join_rank']),
      topologyRole: json['topology_role']?.toString(),
      topologyEpoch: _toInt(json['topology_epoch']),
      topologyState: json['topology_state']?.toString(),
      activeHubMac: json['active_hub_mac']?.toString().toUpperCase(),
      transportMode: json['transport_mode']?.toString(),
      lastTransportChange: _dateString(json['last_transport_change']),
    );
  }

  static int? _toInt(dynamic value) {
    if (value is num) return value.toInt();
    return int.tryParse(value?.toString() ?? '');
  }

  static String? _dateString(dynamic value) {
    if (value == null) return null;
    if (value is DateTime) return value.toIso8601String();
    return value.toString();
  }
}
