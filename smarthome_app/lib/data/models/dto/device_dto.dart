class DeviceDto {
  const DeviceDto({
    required this.mac,
    required this.ownerId,
    required this.name,
    required this.productId,
    required this.catalogRevision,
    required this.isActive,
    required this.isOnline,
    required this.stateVersion,
    required this.instances,
    required this.diagnostics,
    required this.permissions,
    this.membershipRole,
    this.lastSeen,
    this.networkId,
    this.joinRank,
    this.topologyRole,
    this.topologyEpoch,
    this.topologyState,
    this.activeHubMac,
    this.transportMode,
    this.lastTransportChange,
  });

  final String mac;
  final String ownerId;
  final String name;
  final String productId;
  final int catalogRevision;
  final bool isActive;
  final bool isOnline;
  final int stateVersion;
  final Map<String, dynamic> instances;
  final Map<String, dynamic> diagnostics;
  final List<String> permissions;
  final String? membershipRole;
  final String? lastSeen;
  final String? networkId;
  final int? joinRank;
  final String? topologyRole;
  final int? topologyEpoch;
  final String? topologyState;
  final String? activeHubMac;
  final String? transportMode;
  final String? lastTransportChange;

  factory DeviceDto.fromJson(Map<String, dynamic> json) {
    final shadow = _map(json['shadow']);
    return DeviceDto(
      mac: json['mac']?.toString().toUpperCase() ?? '',
      ownerId: json['owner_id']?.toString() ?? '',
      name: json['name']?.toString() ?? '',
      productId: json['product_id']?.toString() ?? '',
      catalogRevision: _toInt(json['catalog_revision']) ?? 0,
      isActive: json['is_active'] as bool? ?? true,
      isOnline: shadow['is_online'] as bool? ?? false,
      stateVersion: _toInt(shadow['state_version']) ?? 0,
      instances: _map(shadow['instances']),
      diagnostics: _map(shadow['diagnostics']),
      permissions: (json['permissions'] as List? ?? const [])
          .map((value) => value.toString())
          .toList(growable: false),
      membershipRole: json['role']?.toString(),
      lastSeen: _dateString(shadow['last_seen']),
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

  static Map<String, dynamic> _map(dynamic value) => value is Map
      ? Map<String, dynamic>.from(value)
      : <String, dynamic>{};

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
