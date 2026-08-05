import 'package:flutter/material.dart';
import '../../features/dashboard/models/capability_model.dart';
import '../../core/widgets/indicators/status_badge.dart' show DeviceStatus;
import 'device_topology.dart';
import 'product_model.dart';

class DeviceModel {
  final String mac; // Canonical device identifier (matches backend)
  final String ownerId;
  final String name;
  final String productId;
  final String uiProfile;
  final int uiProfileVersion;
  final IconData icon;
  final DeviceStatus status; // online, offline
  final int stateVersion;
  final Map<String, dynamic> instances;
  final Map<String, dynamic> rawState;
  final Map<String, dynamic> diagnostics;
  final List<String> permissions;
  final String? membershipRole;
  final String? lastSeen;
  final DeviceTopology? topology;
  final List<DeviceResourceDefinition> resources;
  final List<DeviceCredentialDefinition> credentials;

  // Danh sách capabilities sau khi đã ghép nối với Product Catalog
  final List<CapabilityModel> capabilities;

  DeviceModel({
    required this.mac,
    required this.ownerId,
    required this.name,
    required this.productId,
    this.uiProfile = 'generic',
    this.uiProfileVersion = 1,
    required this.icon,
    required this.status,
    this.stateVersion = 0,
    this.instances = const {},
    required this.rawState,
    required this.diagnostics,
    this.permissions = const [],
    this.membershipRole,
    required this.capabilities,
    this.lastSeen,
    this.topology,
    this.resources = const [],
    this.credentials = const [],
  });

  DeviceModel copyWith({
    String? mac,
    String? ownerId,
    String? name,
    String? productId,
    String? uiProfile,
    int? uiProfileVersion,
    IconData? icon,
    DeviceStatus? status,
    int? stateVersion,
    Map<String, dynamic>? instances,
    Map<String, dynamic>? rawState,
    Map<String, dynamic>? diagnostics,
    List<String>? permissions,
    String? membershipRole,
    List<CapabilityModel>? capabilities,
    String? lastSeen,
    DeviceTopology? topology,
    bool clearTopology = false,
    List<DeviceResourceDefinition>? resources,
    List<DeviceCredentialDefinition>? credentials,
  }) {
    return DeviceModel(
      mac: mac ?? this.mac,
      ownerId: ownerId ?? this.ownerId,
      name: name ?? this.name,
      productId: productId ?? this.productId,
      uiProfile: uiProfile ?? this.uiProfile,
      uiProfileVersion: uiProfileVersion ?? this.uiProfileVersion,
      icon: icon ?? this.icon,
      status: status ?? this.status,
      stateVersion: stateVersion ?? this.stateVersion,
      instances: instances ?? this.instances,
      rawState: rawState ?? this.rawState,
      diagnostics: diagnostics ?? this.diagnostics,
      permissions: permissions ?? this.permissions,
      membershipRole: membershipRole ?? this.membershipRole,
      capabilities: capabilities ?? this.capabilities,
      lastSeen: lastSeen ?? this.lastSeen,
      topology: clearTopology ? null : topology ?? this.topology,
      resources: resources ?? this.resources,
      credentials: credentials ?? this.credentials,
    );
  }

  bool get isPrimaryOn {
    final onOffCap = capabilities.firstWhere(
      (c) => c.type == 'on_off',
      orElse: () =>
          const CapabilityModel(id: '', type: '', name: '', value: false),
    );
    return onOffCap.value as bool? ?? false;
  }
}
