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
    );
  }
}
