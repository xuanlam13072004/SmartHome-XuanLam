import 'package:flutter/material.dart';
import '../../features/dashboard/models/capability_model.dart';
import '../../core/widgets/indicators/status_badge.dart' show DeviceStatus;

class DeviceModel {
  final String id;
  final String ownerId;
  final String mac;
  final String name;
  final String productId;
  final String room; // Fallback vì API chưa có room
  final IconData icon;
  final DeviceStatus status; // online, offline
  final Map<String, dynamic> rawState;
  final Map<String, dynamic> diagnostics;
  
  // Danh sách capabilities sau khi đã ghép nối với Product Catalog
  final List<CapabilityModel> capabilities;

  DeviceModel({
    required this.id,
    required this.ownerId,
    required this.mac,
    required this.name,
    required this.productId,
    required this.room,
    required this.icon,
    required this.status,
    required this.rawState,
    required this.diagnostics,
    required this.capabilities,
  });

  DeviceModel copyWith({
    String? id,
    String? ownerId,
    String? mac,
    String? name,
    String? productId,
    String? room,
    IconData? icon,
    DeviceStatus? status,
    Map<String, dynamic>? rawState,
    Map<String, dynamic>? diagnostics,
    List<CapabilityModel>? capabilities,
  }) {
    return DeviceModel(
      id: id ?? this.id,
      ownerId: ownerId ?? this.ownerId,
      mac: mac ?? this.mac,
      name: name ?? this.name,
      productId: productId ?? this.productId,
      room: room ?? this.room,
      icon: icon ?? this.icon,
      status: status ?? this.status,
      rawState: rawState ?? this.rawState,
      diagnostics: diagnostics ?? this.diagnostics,
      capabilities: capabilities ?? this.capabilities,
    );
  }

  bool get isPrimaryOn {
    final onOffCap = capabilities.firstWhere(
      (c) => c.type == 'on_off',
      orElse: () => const CapabilityModel(id: '', type: '', name: '', value: false),
    );
    return onOffCap.value as bool? ?? false;
  }
}
