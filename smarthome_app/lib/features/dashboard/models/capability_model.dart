/// Mô phỏng cấu trúc JSON trả về từ backend cho một capability.
/// Frontend không cần quan tâm đây là thiết bị gì, chỉ render dựa trên type.
class CapabilityModel {
  final String id;
  final String type; // 'on_off', 'range', 'sensor', 'enum'
  final String name; // 'Nhiệt độ', 'Chế độ', 'Độ sáng'
  final dynamic value; // Giá trị hiện tại: bool, double, int, String
  final Map<String, dynamic> properties; // metadata: min, max, step, options...
  final bool isReadOnly; // sensor thì readOnly = true

  const CapabilityModel({
    required this.id,
    required this.type,
    required this.name,
    this.value,
    this.properties = const {},
    this.isReadOnly = false,
  });

  /// Clone model (Dùng để thay đổi value tạm thời trong UI tĩnh)
  CapabilityModel copyWith({
    String? id,
    String? type,
    String? name,
    dynamic value,
    Map<String, dynamic>? properties,
    bool? isReadOnly,
  }) {
    return CapabilityModel(
      id: id ?? this.id,
      type: type ?? this.type,
      name: name ?? this.name,
      value: value ?? this.value,
      properties: properties ?? this.properties,
      isReadOnly: isReadOnly ?? this.isReadOnly,
    );
  }
}
