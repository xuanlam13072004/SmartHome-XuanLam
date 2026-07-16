class DeviceDto {
  final String id;
  final String ownerId;
  final String mac;
  final String name;
  final String productId;
  final bool isActive;
  final bool isOnline;
  final Map<String, dynamic> state;
  final Map<String, dynamic> diagnostics;

  DeviceDto({
    required this.id,
    required this.ownerId,
    required this.mac,
    required this.name,
    required this.productId,
    required this.isActive,
    required this.isOnline,
    required this.state,
    required this.diagnostics,
  });

  factory DeviceDto.fromJson(Map<String, dynamic> json) {
    return DeviceDto(
      id: json['id'] as String? ?? '',
      ownerId: json['owner_id'] as String? ?? '',
      mac: json['mac'] as String? ?? '',
      name: json['name'] as String? ?? '',
      productId: json['product_id'] as String? ?? '',
      isActive: json['is_active'] as bool? ?? false,
      isOnline: json['is_online'] as bool? ?? false,
      state: json['state'] as Map<String, dynamic>? ?? {},
      diagnostics: json['diagnostics'] as Map<String, dynamic>? ?? {},
    );
  }
}
