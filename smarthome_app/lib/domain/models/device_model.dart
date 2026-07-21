import 'package:flutter/material.dart';
import '../../features/dashboard/models/capability_model.dart';
import '../../core/widgets/indicators/status_badge.dart' show DeviceStatus;

class DeviceModel {
  final String mac; // Canonical device identifier (matches backend)
  final String ownerId;
  final String name;
  final String productId;
  final IconData icon;
  final DeviceStatus status; // online, offline
  final Map<String, dynamic> rawState;
  final Map<String, dynamic> diagnostics;
  final String? lastSeen;
  final int? rssi;
  final int? battery;

  // Danh sách capabilities sau khi đã ghép nối với Product Catalog
  final List<CapabilityModel> capabilities;

  DeviceModel({
    required this.mac,
    required this.ownerId,
    required this.name,
    required this.productId,
    required this.icon,
    required this.status,
    required this.rawState,
    required this.diagnostics,
    required this.capabilities,
    this.lastSeen,
    this.rssi,
    this.battery,
  });

  DeviceModel copyWith({
    String? mac,
    String? ownerId,
    String? name,
    String? productId,
    IconData? icon,
    DeviceStatus? status,
    Map<String, dynamic>? rawState,
    Map<String, dynamic>? diagnostics,
    List<CapabilityModel>? capabilities,
    String? lastSeen,
    int? rssi,
    int? battery,
  }) {
    return DeviceModel(
      mac: mac ?? this.mac,
      ownerId: ownerId ?? this.ownerId,
      name: name ?? this.name,
      productId: productId ?? this.productId,
      icon: icon ?? this.icon,
      status: status ?? this.status,
      rawState: rawState ?? this.rawState,
      diagnostics: diagnostics ?? this.diagnostics,
      capabilities: capabilities ?? this.capabilities,
      lastSeen: lastSeen ?? this.lastSeen,
      rssi: rssi ?? this.rssi,
      battery: battery ?? this.battery,
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
