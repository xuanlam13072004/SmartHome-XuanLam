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
  final String category;
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
    this.category = '',
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
    String? category,
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
      category: category ?? this.category,
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

  /// Returns true if the device's primary state is considered "active/on".
  ///
  /// Catalog v2 does not have an `on_off` capability — devices express their
  /// primary state through domain-specific capabilities. This getter examines
  /// the actual capability values to determine an "active" state, which drives
  /// glow effects, icon tinting, and status labels in the UI.
  bool get isPrimaryOn {
    var hasPrimarySignal = false;

    for (final cap in capabilities) {
      final capId = cap.capabilityId.toLowerCase();
      final id = cap.id.toLowerCase();
      final value = cap.value;
      final normalised = '$value'.toLowerCase();

      if (id == 'lock_state' && capId == 'door_lock') {
        hasPrimarySignal = true;
        if (const {'unlocked', 'unlocking', 'open'}.contains(normalised)) {
          return true;
        }
      }

      if (id == 'movement' && capId == 'cover_controller') {
        hasPrimarySignal = true;
        if (const {'opening', 'closing', 'running'}.contains(normalised)) {
          return true;
        }
      }

      if (id == 'audible_state' && capId == 'alarm_siren') {
        hasPrimarySignal = true;
        if (normalised == 'sounding') return true;
      }

      if (capId == 'irrigation_pump' &&
          const {'pump_output_state', 'pump_state', 'pump_active'}
              .contains(id)) {
        hasPrimarySignal = true;
        if (const {'running', 'true', 'on'}.contains(normalised)) return true;
      }

      if (id == 'flame_detected' && capId == 'flame_detection') {
        hasPrimarySignal = true;
        if (value == true) return true;
      }
    }

    if (hasPrimarySignal) return false;

    return capabilities.any(
        (cap) => cap.section == CapabilitySection.control && cap.value == true);
  }
}
