import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:smarthome_app/core/core.dart';
import 'package:smarthome_app/core/widgets/widgets.dart';
import 'package:smarthome_app/domain/models/device_model.dart';
import 'package:smarthome_app/domain/models/device_topology.dart';
import 'package:smarthome_app/features/dashboard/models/capability_model.dart';
import 'package:smarthome_app/features/products/product_ui_profile.dart';
import 'package:smarthome_app/features/products/product_ui_registry.dart';

const profiles = <String>[
  ProductUiProfile.entranceController,
  ProductUiProfile.roofController,
  ProductUiProfile.hazardMonitor,
  ProductUiProfile.irrigationManager,
];

typedef _Request = (String, dynamic);

Future<List<_Request>> _pumpDetail(
  WidgetTester tester,
  DeviceModel device, {
  double width = 390,
  double height = 1400,
  bool resolve = false,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, height);
  addTearDown(tester.view.reset);
  final requests = <_Request>[];
  await tester.pumpWidget(
    MaterialApp(
      key: ValueKey('${device.mac}-$width'),
      theme: AppTheme.light,
      home: Scaffold(
        body: Builder(
          builder: (context) => Padding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
            child: productUiRegistry.buildDetail(
              context,
              device: device,
              onCapabilityChanged: (capability, value) async {
                requests.add((
                  resolve
                      ? capability.resolveOperation(value).operationName
                      : capability.operations.single.operationName,
                  value,
                ));
              },
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pump();
  return requests;
}

/// Pumps fixed frames instead of settling: some pages show endless spinners
/// for devices that are moving (for example a roof that is closing).
Future<void> _settle(WidgetTester tester) async {
  for (var frame = 0; frame < 6; frame++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

Future<void> _tapText(WidgetTester tester, String text) async {
  await tester.ensureVisible(find.text(text));
  await _settle(tester);
  await tester.tap(find.text(text));
  await tester.pump();
}

void main() {
  for (final profile in [...profiles, ProductUiProfile.securityCamera]) {
    testWidgets('$profile mini card fits the compact dashboard cell',
        (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(390, 844);
      addTearDown(tester.view.reset);
      final device = _device(profile);

      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light,
          home: Scaffold(
            body: Center(
              child: Builder(
                builder: (context) => SizedBox(
                  width: 171,
                  height: 230,
                  child: productUiRegistry.buildMiniCard(
                    context,
                    device: device,
                    onTap: () {},
                    onCapabilityChanged: (_, __) async {},
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pump();

      expect(tester.takeException(), isNull);
      expect(find.text(device.name), findsOneWidget);
    });
  }

  for (final profile in profiles) {
    for (final width in [320.0, 414.0, 768.0]) {
      testWidgets('$profile page renders at ${width.toInt()}px without '
          'diagnostics', (tester) async {
        await _pumpDetail(tester, _device(profile), width: width);

        expect(tester.takeException(), isNull);
        expect(find.byType(Scrollable), findsWidgets);
        for (final hidden in [
          'Chẩn đoán',
          'Tín hiệu Wi-Fi',
          'Tình trạng firmware',
          'Kết nối Wi-Fi không ổn định',
          'Firmware của thiết bị cần được kiểm tra',
          'Thông số khác',
          'Điều khiển khác',
        ]) {
          expect(find.text(hidden), findsNothing, reason: hidden);
        }
      });
    }
  }

  testWidgets('entrance: big lock button unlocks; LCD message lives in a sheet',
      (tester) async {
    final requests =
        await _pumpDetail(tester, _entranceDevice, height: 1800, resolve: true);

    expect(find.text('Đã khóa'), findsOneWidget);
    expect(find.text('Mở khóa'), findsOneWidget);
    expect(find.byKey(const ValueKey('entrance-lcd-line-0')), findsNothing);

    await _tapText(tester, 'Mở khóa');
    expect(requests, [('unlock', 'unlocking')]);

    requests.clear();
    await _tapText(tester, 'Lời nhắn trên màn hình cửa');
    await _settle(tester);
    expect(find.byKey(const ValueKey('entrance-lcd-line-0')), findsOneWidget);
    await tester.enterText(
      find.byKey(const ValueKey('entrance-lcd-line-0')),
      '12345678901234567890EXTRA',
    );
    await tester.enterText(
      find.byKey(const ValueKey('entrance-lcd-line-1')),
      'Xin chao',
    );
    await _tapText(tester, 'Hiển thị lời nhắn');

    expect(requests, hasLength(1));
    expect(requests.single.$1, 'set_custom_message');
    expect(
      requests.single.$2,
      ['12345678901234567890', 'Xin chao', 'Cua dang khoa', ''],
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('roof: open/close tiles and the automatic switch send commands',
      (tester) async {
    final requests = await _pumpDetail(tester, _roofDevice);

    expect(find.text('Đang đóng mái…'), findsOneWidget);
    expect(find.text('Khô ráo'), findsOneWidget);
    expect(find.text('Kết nối mạng'), findsNothing, reason: 'Hub–Node is in the chip sheet');
    expect(find.text('Qua Hub'), findsOneWidget);

    await _tapText(tester, 'Mở mái');
    await tester.ensureVisible(find.byType(Switch));
    await tester.tap(find.byType(Switch));
    await tester.pump();

    expect(requests, [('open', 'opening'), ('set_control_mode', 'automatic')]);

    await tester.tap(find.text('Qua Hub'));
    await _settle(tester);
    expect(find.text('Kết nối mạng'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('hazard: safe state, sensor tiles and temporary siren mute',
      (tester) async {
    final requests = await _pumpDetail(tester, _hazardDevice());

    expect(find.text('An toàn'), findsOneWidget);
    for (final label in ['Khí gas', 'Khói', 'Lửa', 'Nhiệt độ', 'Độ ẩm']) {
      expect(find.text(label), findsOneWidget, reason: label);
    }
    expect(find.text('30°C'), findsOneWidget);
    expect(find.text('65%'), findsOneWidget);
    expect(find.text('12%'), findsOneWidget);
    expect(find.text('4%'), findsOneWidget);
    expect(find.text('Không có'), findsOneWidget);
    expect(find.text('Còi sẵn sàng'), findsOneWidget);
    expect(find.text('Sự cố đang diễn ra'), findsNothing);

    await _tapText(tester, '3 phút');
    await _tapText(tester, 'Tắt còi tạm thời');
    expect(requests, [('mute_siren', 180)]);
    expect(tester.takeException(), isNull);
  });

  testWidgets('hazard: sounding and muted sirens', (tester) async {
    await _pumpDetail(tester, _hazardDevice(sirenState: 'sounding'));
    expect(find.text('Còi đang kêu'), findsOneWidget);

    final requests =
        await _pumpDetail(tester, _hazardDevice(sirenState: 'muted'), width: 391);
    expect(find.text('Còi đang tạm tắt'), findsOneWidget);
    await _tapText(tester, 'Bật lại còi ngay');
    expect(requests, [('resume_siren', 'resume')]);
    expect(tester.takeException(), isNull);
  });

  testWidgets('hazard: an active incident can be acknowledged', (tester) async {
    final requests =
        await _pumpDetail(tester, _hazardDevice(incidentState: 'active'));

    expect(find.text('Sự cố đang diễn ra'), findsOneWidget);
    await _tapText(tester, 'Tôi đã biết');
    expect(requests, [('acknowledge_incident', 'inc-1')]);
    expect(tester.takeException(), isNull);
  });

  testWidgets('irrigation: water now with the chosen duration and auto mode',
      (tester) async {
    for (final width in [320.0, 414.0]) {
      final requests =
          await _pumpDetail(tester, _irrigationDevice, width: width);

      expect(find.byType(Slider), findsNothing);
      expect(find.text('Đang nghỉ'), findsOneWidget);
      expect(find.text('42%'), findsOneWidget);
      expect(find.text('80%'), findsOneWidget);
      expect(find.text('Tự động tưới'), findsOneWidget);
      expect(find.text('Bảo vệ máy bơm'), findsOneWidget);
      expect(find.textContaining('Giữ độ ẩm đất quanh 50%'), findsOneWidget);
      expect(find.textContaining('Tối đa 15 phút mỗi lần'), findsOneWidget);

      await _tapText(tester, 'Tưới ngay');
      await _tapText(tester, '1 phút');
      await _tapText(tester, 'Tưới ngay');
      await tester.ensureVisible(find.byType(Switch));
      await tester.tap(find.byType(Switch));
      await tester.pump();

      expect(requests, [
        ('water_for_duration', 300),
        ('water_for_duration', 60),
        ('set_control_mode', 'manual'),
      ]);
      expect(tester.takeException(), isNull, reason: 'width=$width');
    }
  });
}

final _roofDevice = DeviceModel(
  mac: 'AA:BB:CC:DD:EE:20',
  ownerId: 'owner-1',
  name: 'Mái che sân thượng',
  productId: 'prod_roof_controller',
  uiProfile: ProductUiProfile.roofController,
  uiProfileVersion: 1,
  category: 'environment',
  icon: Icons.roofing_rounded,
  status: DeviceStatus.online,
  rawState: const {
    'movement': 'closing',
    'rain_detected': false,
    'control_mode': 'manual',
  },
  diagnostics: const {},
  capabilities: const [
    CapabilityModel(
      id: 'movement',
      type: 'enum',
      name: 'Trạng thái mái',
      value: 'closing',
      properties: {
        'options': ['closed', 'opening', 'open', 'closing'],
      },
      instance: 'roof_motor',
      capabilityId: 'cover_controller',
      semanticRole: 'roof_actuator',
      section: CapabilitySection.control,
      operations: [
        CapabilityOperationDescriptor(operationName: 'open'),
        CapabilityOperationDescriptor(operationName: 'close'),
      ],
    ),
    CapabilityModel(
      id: 'rain_detected',
      type: 'sensor',
      name: 'Trạng thái mưa',
      value: false,
      isReadOnly: true,
      instance: 'rain_sensor',
      capabilityId: 'rain_detection',
      semanticRole: 'rain_detector',
      section: CapabilitySection.sensor,
    ),
    CapabilityModel(
      id: 'control_mode',
      type: 'enum',
      name: 'Chế độ mái che',
      value: 'manual',
      properties: {
        'options': ['manual', 'automatic'],
      },
      instance: 'roof_automation',
      capabilityId: 'roof_policy',
      section: CapabilitySection.control,
      operations: [
        CapabilityOperationDescriptor(
          operationName: 'set_control_mode',
          inputNames: ['mode'],
        ),
      ],
    ),
  ],
  topology: const DeviceTopology(
    networkId: 'network-roof-1',
    role: DeviceTopologyRole.node,
    epoch: 3,
    state: DeviceTopologyState.stable,
    transportMode: DeviceTransportMode.relay,
    joinRank: 2,
    activeHubMac: 'AA:BB:CC:DD:EE:01',
  ),
);

final _entranceDevice = DeviceModel(
  mac: 'AA:BB:CC:DD:EE:10',
  ownerId: 'owner-1',
  name: 'Cửa chính',
  productId: 'prod_entrance_controller',
  uiProfile: ProductUiProfile.entranceController,
  uiProfileVersion: 1,
  category: 'security',
  icon: Icons.door_front_door_rounded,
  status: DeviceStatus.online,
  rawState: const {},
  diagnostics: const {},
  capabilities: const [
    CapabilityModel(
      id: 'lock_state',
      type: 'enum',
      name: 'Trạng thái khóa cửa',
      value: 'locked',
      properties: {
        'options': ['locked', 'unlocked'],
      },
      instance: 'main_lock',
      capabilityId: 'door_lock',
      semanticRole: 'entrance_lock',
      section: CapabilitySection.control,
      operations: [
        CapabilityOperationDescriptor(operationName: 'lock'),
        CapabilityOperationDescriptor(operationName: 'unlock'),
      ],
    ),
    CapabilityModel(
      id: 'displayed_lines',
      type: 'unknown',
      name: 'Nội dung LCD',
      value: ['Nha cua Xuan Lam', '', 'Cua dang khoa', ''],
      instance: 'lcd',
      capabilityId: 'character_display_4x20',
      semanticRole: 'entrance_display',
      section: CapabilitySection.control,
      operations: [
        CapabilityOperationDescriptor(
          operationName: 'set_custom_message',
          inputNames: ['lines'],
        ),
      ],
    ),
    CapabilityModel(
      id: 'display_source',
      type: 'enum',
      name: 'Nguồn hiển thị',
      value: 'firmware',
      instance: 'lcd',
      capabilityId: 'character_display_4x20',
      semanticRole: 'entrance_display',
      section: CapabilitySection.control,
      operations: [
        CapabilityOperationDescriptor(operationName: 'clear_custom_message'),
      ],
    ),
  ],
  topology: const DeviceTopology(
    networkId: 'network-entrance-1',
    role: DeviceTopologyRole.hub,
    epoch: 1,
    state: DeviceTopologyState.stable,
    transportMode: DeviceTransportMode.hub,
    joinRank: 1,
    activeHubMac: 'AA:BB:CC:DD:EE:10',
  ),
);

DeviceModel _hazardDevice({
  String sirenState = 'silent',
  String incidentState = 'idle',
}) =>
    DeviceModel(
      mac: 'AA:BB:CC:DD:EE:30',
      ownerId: 'owner-1',
      name: 'Cảnh báo an toàn bếp',
      productId: 'prod_hazard_mitigation',
      uiProfile: ProductUiProfile.hazardMonitor,
      uiProfileVersion: 1,
      category: 'safety',
      icon: Icons.health_and_safety_rounded,
      status: DeviceStatus.online,
      rawState: const {},
      diagnostics: const {},
      capabilities: [
        const CapabilityModel(
          id: 'temperature',
          type: 'sensor',
          name: 'Nhiệt độ DHT11',
          value: 30,
          properties: {'unit': 'celsius'},
          isReadOnly: true,
          instance: 'kitchen_temperature',
          capabilityId: 'temperature_measurement',
          section: CapabilitySection.sensor,
        ),
        const CapabilityModel(
          id: 'humidity',
          type: 'sensor',
          name: 'Độ ẩm DHT11',
          value: 65,
          properties: {'unit': 'percent'},
          isReadOnly: true,
          instance: 'kitchen_humidity',
          capabilityId: 'humidity_measurement',
          section: CapabilitySection.sensor,
        ),
        const CapabilityModel(
          id: 'gas_level',
          type: 'sensor',
          name: 'Mức khí gas',
          value: 12,
          properties: {'unit': 'normalized'},
          isReadOnly: true,
          instance: 'kitchen_gas',
          capabilityId: 'gas_measurement',
          section: CapabilitySection.sensor,
        ),
        const CapabilityModel(
          id: 'smoke_level',
          type: 'sensor',
          name: 'Mức khói',
          value: 4,
          properties: {'unit': 'normalized'},
          isReadOnly: true,
          instance: 'kitchen_smoke',
          capabilityId: 'smoke_measurement',
          section: CapabilitySection.sensor,
        ),
        const CapabilityModel(
          id: 'flame_detected',
          type: 'sensor',
          name: 'Phát hiện lửa',
          value: false,
          isReadOnly: true,
          instance: 'kitchen_flame',
          capabilityId: 'flame_detection',
          section: CapabilitySection.sensor,
        ),
        const CapabilityModel(
          id: 'risk_level',
          type: 'enum',
          name: 'Mức nguy hiểm',
          value: 'normal',
          isReadOnly: true,
          instance: 'hazard',
          capabilityId: 'hazard_controller',
          section: CapabilitySection.sensor,
        ),
        CapabilityModel(
          id: 'incident_state',
          type: 'enum',
          name: 'Vòng đời sự cố',
          value: incidentState,
          instance: 'hazard',
          capabilityId: 'hazard_controller',
          section: CapabilitySection.control,
          operations: const [
            CapabilityOperationDescriptor(
              operationName: 'acknowledge_incident',
              inputNames: ['incident_id'],
              confirmation: 'confirm',
            ),
            CapabilityOperationDescriptor(
              operationName: 'reset_incident',
              inputNames: ['incident_id'],
              confirmation: 'reauthenticate',
            ),
          ],
        ),
        CapabilityModel(
          id: 'active_incident_id',
          type: 'sensor',
          name: 'Sự cố hiện tại',
          value: incidentState == 'idle' ? null : 'inc-1',
          isReadOnly: true,
          instance: 'hazard',
          capabilityId: 'hazard_controller',
          section: CapabilitySection.sensor,
        ),
        CapabilityModel(
          id: 'audible_state',
          type: 'enum',
          name: 'Lệnh đầu ra còi',
          value: sirenState,
          properties: const {
            'options': ['silent', 'sounding', 'muted'],
          },
          instance: 'alarm_siren',
          capabilityId: 'alarm_siren',
          section: CapabilitySection.control,
          operations: const [
            CapabilityOperationDescriptor(
              operationName: 'mute_siren',
              inputNames: ['duration_seconds'],
              inputSchema: {
                'duration_seconds': {
                  'type': 'integer',
                  'enum': [60, 180, 300, 600, 1800],
                  'default': 60,
                },
              },
              confirmation: 'confirm',
            ),
            CapabilityOperationDescriptor(
              operationName: 'resume_siren',
              label: 'Bật lại cảnh báo ngay',
            ),
          ],
        ),
        const CapabilityModel(
          id: 'mute_until',
          type: 'text',
          name: 'Tắt còi đến',
          isReadOnly: true,
          instance: 'alarm_siren',
          capabilityId: 'alarm_siren',
          section: CapabilitySection.sensor,
        ),
        const CapabilityModel(
          id: 'test_siren',
          type: 'operation',
          name: 'Kiểm tra còi',
          instance: 'alarm_siren',
          capabilityId: 'alarm_siren',
          section: CapabilitySection.control,
          operations: [
            CapabilityOperationDescriptor(
              operationName: 'test_siren',
              inputNames: ['duration_seconds'],
              confirmation: 'confirm',
            ),
          ],
        ),
        const CapabilityModel(
          id: 'pressed',
          type: 'sensor',
          name: 'Nút tắt âm tại chỗ',
          value: false,
          isReadOnly: true,
          instance: 'mute_button',
          capabilityId: 'local_button',
          section: CapabilitySection.sensor,
        ),
      ],
      topology: const DeviceTopology(
        networkId: 'network-hazard-1',
        role: DeviceTopologyRole.hub,
        epoch: 2,
        state: DeviceTopologyState.stable,
        transportMode: DeviceTransportMode.hub,
        joinRank: 1,
        activeHubMac: 'AA:BB:CC:DD:EE:30',
      ),
    );

final _irrigationDevice = DeviceModel(
  mac: 'AA:BB:CC:DD:EE:40',
  ownerId: 'owner-1',
  name: 'Bơm vườn',
  productId: 'prod_irrigation_manager',
  uiProfile: ProductUiProfile.irrigationManager,
  uiProfileVersion: 1,
  category: 'agriculture',
  icon: Icons.grass_rounded,
  status: DeviceStatus.online,
  rawState: const {},
  diagnostics: const {
    'system': {'wifi_rssi': -60, 'firmware_status': 'healthy'},
  },
  capabilities: const [
    CapabilityModel(
      id: 'moisture_level',
      type: 'sensor',
      name: 'Độ ẩm đất',
      value: 42,
      properties: {'unit': 'normalized'},
      isReadOnly: true,
      instance: 'main_garden',
      capabilityId: 'soil_moisture_measurement',
      section: CapabilitySection.sensor,
    ),
    CapabilityModel(
      id: 'water_availability',
      type: 'sensor',
      name: 'Nguồn nước',
      value: 'available',
      isReadOnly: true,
      instance: 'reservoir',
      capabilityId: 'water_level_measurement',
      section: CapabilitySection.sensor,
    ),
    CapabilityModel(
      id: 'level_normalized',
      type: 'sensor',
      name: 'Mực nước',
      value: 80,
      properties: {'unit': 'normalized'},
      isReadOnly: true,
      instance: 'reservoir',
      capabilityId: 'water_level_measurement',
      section: CapabilitySection.sensor,
    ),
    CapabilityModel(
      id: 'pump_output_state',
      type: 'enum',
      name: 'Máy bơm',
      value: 'stopped',
      instance: 'irrigation_pump',
      capabilityId: 'irrigation_pump',
      section: CapabilitySection.control,
      operations: [
        CapabilityOperationDescriptor(
          operationName: 'water_for_duration',
          inputNames: ['duration_seconds'],
        ),
        CapabilityOperationDescriptor(operationName: 'stop'),
      ],
    ),
    CapabilityModel(
      id: 'control_mode',
      type: 'enum',
      name: 'Chế độ tưới',
      value: 'automatic',
      properties: {
        'options': ['manual', 'automatic'],
      },
      instance: 'irrigation_automation',
      capabilityId: 'irrigation_policy',
      section: CapabilitySection.control,
      operations: [
        CapabilityOperationDescriptor(
          operationName: 'set_control_mode',
          inputNames: ['mode'],
        ),
      ],
    ),
    CapabilityModel(
      id: 'target_moisture',
      type: 'sensor',
      name: 'Độ ẩm mục tiêu',
      value: 50,
      isReadOnly: true,
      instance: 'irrigation_automation',
      capabilityId: 'irrigation_policy',
      section: CapabilitySection.sensor,
    ),
    CapabilityModel(
      id: 'moisture_hysteresis',
      type: 'sensor',
      name: 'Vùng trễ độ ẩm',
      value: 5,
      isReadOnly: true,
      instance: 'irrigation_automation',
      capabilityId: 'irrigation_policy',
      section: CapabilitySection.sensor,
    ),
    CapabilityModel(
      id: 'default_cycle_duration_seconds',
      type: 'sensor',
      name: 'Thời lượng tưới tự động',
      value: 300,
      isReadOnly: true,
      instance: 'irrigation_automation',
      capabilityId: 'irrigation_policy',
      section: CapabilitySection.sensor,
    ),
    CapabilityModel(
      id: 'maximum_runtime_seconds',
      type: 'sensor',
      name: 'Giới hạn chạy an toàn',
      value: 900,
      isReadOnly: true,
      instance: 'irrigation_automation',
      capabilityId: 'irrigation_policy',
      section: CapabilitySection.sensor,
    ),
    CapabilityModel(
      id: 'cooldown_seconds',
      type: 'sensor',
      name: 'Thời gian nghỉ bảo vệ bơm',
      value: 60,
      isReadOnly: true,
      instance: 'irrigation_automation',
      capabilityId: 'irrigation_policy',
      section: CapabilitySection.sensor,
    ),
    CapabilityModel(
      id: 'wifi_rssi',
      type: 'sensor',
      name: 'Tín hiệu Wi-Fi',
      value: -60,
      properties: {
        'min': -120,
        'max': 0,
        'unit': 'dbm',
        'ui_hint': 'signal_strength',
      },
      isReadOnly: true,
      instance: 'system',
      capabilityId: 'system_diagnostics',
      section: CapabilitySection.diagnostic,
    ),
    CapabilityModel(
      id: 'firmware_status',
      type: 'sensor',
      name: 'Tình trạng firmware',
      value: 'healthy',
      properties: {'ui_hint': 'firmware_health'},
      isReadOnly: true,
      instance: 'system',
      capabilityId: 'system_diagnostics',
      section: CapabilitySection.diagnostic,
    ),
  ],
);

DeviceModel _irrigationWithDiagnostics({
  required double rssi,
  required String firmwareStatus,
}) =>
    _irrigationDevice.copyWith(
      diagnostics: {
        'system': {
          'wifi_rssi': rssi,
          'firmware_status': firmwareStatus,
        },
      },
      capabilities: [
        ..._irrigationDevice.capabilities.where(
          (item) => item.section != CapabilitySection.diagnostic,
        ),
        CapabilityModel(
          id: 'wifi_rssi',
          type: 'sensor',
          name: 'Tín hiệu Wi-Fi',
          value: rssi,
          properties: const {
            'min': -120,
            'max': 0,
            'unit': 'dbm',
            'ui_hint': 'signal_strength',
          },
          isReadOnly: true,
          instance: 'system',
          capabilityId: 'system_diagnostics',
          section: CapabilitySection.diagnostic,
        ),
        CapabilityModel(
          id: 'firmware_status',
          type: 'sensor',
          name: 'Tình trạng firmware',
          value: firmwareStatus,
          properties: const {'ui_hint': 'firmware_health'},
          isReadOnly: true,
          instance: 'system',
          capabilityId: 'system_diagnostics',
          section: CapabilitySection.diagnostic,
        ),
      ],
    );

DeviceModel _device(String profile) {
  if (profile == ProductUiProfile.roofController) return _roofDevice;
  if (profile == ProductUiProfile.hazardMonitor) return _hazardDevice();
  if (profile == ProductUiProfile.entranceController) return _entranceDevice;
  if (profile == ProductUiProfile.irrigationManager) {
    return _irrigationWithDiagnostics(rssi: -82, firmwareStatus: 'fault');
  }
  return DeviceModel(
    mac: 'AA:BB:CC:DD:EE:FF',
    ownerId: 'owner-1',
    name: 'Thiết bị kiểm thử',
    productId: 'prod_$profile',
    uiProfile: profile,
    uiProfileVersion: 1,
    icon: Icons.devices_other_rounded,
    status: DeviceStatus.online,
    rawState: const {},
    diagnostics: const {},
    capabilities: const [],
  );
}
