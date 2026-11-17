import 'package:flutter/material.dart';

import '../../core/widgets/indicators/status_badge.dart' show DeviceStatus;
import '../../domain/models/device_model.dart';
import '../products/product_ui_profile.dart';
import '../products/product_ui_registry.dart';
import '../products/widgets/product_page_kit.dart' show productProperty, productText;
import 'data/room_models.dart';

/// One short live fact about a room ("31°C", "Đã khóa").
class RoomReading {
  const RoomReading({required this.icon, required this.label, this.warning = false});

  final IconData icon;
  final String label;
  final bool warning;
}

/// What a room looks like right now, worked out from its devices' live state.
class RoomSummary {
  const RoomSummary({
    required this.total,
    required this.online,
    required this.alerts,
    required this.readings,
  });

  final int total;
  final int online;

  /// Online devices that need attention (fire risk, empty tank, lock fault…).
  final int alerts;
  final List<RoomReading> readings;

  int get offline => total - online;

  /// "3 thiết bị · 1 ngoại tuyến".
  String get countLabel {
    if (total == 0) return 'Chưa có thiết bị';
    if (offline == 0) return '$total thiết bị';
    return '$total thiết bị · $offline ngoại tuyến';
  }
}

String _profile(DeviceModel device) => productUiRegistry.profileOf(device);

String _text(DeviceModel device, String capabilityId, String propertyId) =>
    productText(productProperty(device, capabilityId: capabilityId, propertyId: propertyId));

num? _number(DeviceModel device, String capabilityId, String propertyId) {
  final value = productProperty(device, capabilityId: capabilityId, propertyId: propertyId)?.value;
  return value is num ? value : num.tryParse('${value ?? ''}');
}

bool _online(DeviceModel device) => device.status == DeviceStatus.online;

/// Whether an online device reports something the user should look at.
bool deviceNeedsAttention(DeviceModel device) {
  if (!_online(device)) return false;
  switch (_profile(device)) {
    case ProductUiProfile.hazardMonitor:
      final flame = _text(device, 'flame_detection', 'flame_detected');
      final risk = _text(device, 'hazard_controller', 'risk_level');
      return flame == 'true' ||
          const {'warning', 'alarm', 'emergency', 'sensor_fault'}.contains(risk) ||
          _text(device, 'alarm_siren', 'audible_state') == 'sounding';
    case ProductUiProfile.irrigationManager:
      return _text(device, 'water_level_measurement', 'water_availability') == 'empty';
    case ProductUiProfile.entranceController:
      return _text(device, 'door_lock', 'lock_state') == 'fault';
    default:
      return false;
  }
}

RoomSummary summarizeRoom(List<DeviceModel> devices) {
  final temperatures = <num>[];
  final humidities = <num>[];
  final soil = <num>[];
  var locks = 0, unlocked = 0, roofs = 0, roofsOpen = 0, cameras = 0, online = 0, alerts = 0;

  for (final device in devices) {
    if (!_online(device)) continue;
    online++;
    if (deviceNeedsAttention(device)) alerts++;
    switch (_profile(device)) {
      case ProductUiProfile.hazardMonitor:
        final temperature = _number(device, 'temperature_measurement', 'temperature');
        final humidity = _number(device, 'humidity_measurement', 'humidity');
        if (temperature != null) temperatures.add(temperature);
        if (humidity != null) humidities.add(humidity);
      case ProductUiProfile.irrigationManager:
        final moisture = _number(device, 'soil_moisture_measurement', 'moisture_level');
        if (moisture != null) soil.add(moisture);
      case ProductUiProfile.entranceController:
        final lock = _text(device, 'door_lock', 'lock_state');
        if (lock.isNotEmpty) locks++;
        if (lock == 'unlocked' || lock == 'unlocking') unlocked++;
      case ProductUiProfile.roofController:
        final movement = _text(device, 'cover_controller', 'movement');
        if (movement.isNotEmpty) roofs++;
        if (movement == 'open' || movement == 'opening') roofsOpen++;
      case ProductUiProfile.securityCamera:
        cameras++;
    }
  }

  int average(List<num> values) => (values.reduce((a, b) => a + b) / values.length).round();

  return RoomSummary(
    total: devices.length,
    online: online,
    alerts: alerts,
    readings: [
      if (temperatures.isNotEmpty)
        RoomReading(icon: Icons.thermostat_rounded, label: '${average(temperatures)}°C'),
      if (humidities.isNotEmpty)
        RoomReading(icon: Icons.water_drop_rounded, label: '${average(humidities)}%'),
      if (soil.isNotEmpty) RoomReading(icon: Icons.grass_rounded, label: 'Đất ${average(soil)}%'),
      if (locks > 0)
        unlocked == 0
            ? const RoomReading(icon: Icons.lock_rounded, label: 'Đã khóa')
            : RoomReading(
                icon: Icons.lock_open_rounded,
                label: locks == 1 ? 'Chưa khóa' : '$unlocked cửa chưa khóa',
                warning: true,
              ),
      if (roofs > 0)
        RoomReading(icon: Icons.roofing_rounded, label: roofsOpen > 0 ? 'Mái mở' : 'Mái đóng'),
      if (cameras > 0) RoomReading(icon: Icons.videocam_rounded, label: '$cameras camera'),
    ],
  );
}

/// Devices grouped by this account's rooms. A device whose room is unknown
/// (deleted elsewhere, list not yet reloaded) counts as unassigned.
class RoomGroups {
  RoomGroups(List<Room> rooms, List<DeviceModel> devices) {
    final known = {for (final room in rooms) room.id};
    for (final room in rooms) {
      byRoom[room.id] = [];
    }
    for (final device in devices) {
      final roomId = device.roomId;
      if (roomId != null && known.contains(roomId)) {
        byRoom[roomId]!.add(device);
      } else {
        unassigned.add(device);
      }
    }
  }

  final Map<String, List<DeviceModel>> byRoom = {};
  final List<DeviceModel> unassigned = [];

  List<DeviceModel> of(String roomId) => byRoom[roomId] ?? const [];
}

/// Rooms proposed for the unassigned devices, from what each product is for.
/// An existing room with the same name is reused by the server.
List<RoomDraft> suggestRooms(List<DeviceModel> unassigned, List<Room> rooms) {
  const plan = <String, (String, String)>{
    ProductUiProfile.entranceController: ('Cổng chính', 'entrance'),
    ProductUiProfile.securityCamera: ('Cổng chính', 'entrance'),
    ProductUiProfile.hazardMonitor: ('Bếp', 'kitchen'),
    ProductUiProfile.irrigationManager: ('Sân vườn', 'garden'),
    ProductUiProfile.roofController: ('Sân thượng', 'rooftop'),
  };
  final existing = {for (final room in rooms) roomNameKey(room.name): room};
  final macsByName = <String, List<String>>{};
  final iconByName = <String, String>{};
  for (final device in unassigned) {
    final target = plan[_profile(device)];
    if (target == null) continue;
    final (name, icon) = target;
    macsByName.putIfAbsent(name, () => []).add(device.mac);
    iconByName[name] = icon;
  }
  return [
    for (final entry in macsByName.entries)
      RoomDraft(
        name: existing[roomNameKey(entry.key)]?.name ?? entry.key,
        icon: existing[roomNameKey(entry.key)]?.icon ?? iconByName[entry.key]!,
        macs: entry.value,
      ),
  ];
}
