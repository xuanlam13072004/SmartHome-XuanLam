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

void main() {
  for (final profile in profiles) {
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

    testWidgets('$profile detail view renders on a narrow phone',
        (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(320, 900);
      addTearDown(tester.view.reset);
      final device = _device(profile);

      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light,
          home: Scaffold(
            body: Builder(
              builder: (context) => Padding(
                padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
                child: productUiRegistry.buildDetail(
                  context,
                  device: device,
                  onCapabilityChanged: (_, __) async {},
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pump();

      expect(tester.takeException(), isNull);
      expect(find.text(device.name), findsOneWidget);
      expect(find.byType(Scrollable), findsOneWidget);
    });
  }

  testWidgets(
      'irrigation detail keeps firmware policy in one note without sliders',
      (tester) async {
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final requests = <(String, dynamic)>[];

    for (final width in [320.0, 375.0, 414.0, 768.0]) {
      tester.view.physicalSize = Size(width, 1100);
      requests.clear();

      await tester.pumpWidget(
        MaterialApp(
          key: ValueKey(width),
          theme: AppTheme.light,
          home: Scaffold(
            body: Builder(
              builder: (context) => Padding(
                padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
                child: productUiRegistry.buildDetail(
                  context,
                  device: _irrigationDevice,
                  onCapabilityChanged: (capability, value) async {
                    requests.add(
                      (capability.operations.single.operationName, value),
                    );
                  },
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pump();

      expect(tester.takeException(), isNull, reason: 'width=$width');
      expect(find.byType(Slider), findsNothing, reason: 'width=$width');
      expect(find.text('Tưới thủ công'), findsOneWidget);
      expect(find.text('Tự động tưới'), findsOneWidget);
      expect(find.text('Chẩn đoán'), findsNothing);
      expect(find.text('Kết nối Wi-Fi không ổn định'), findsNothing);
      expect(
          find.text('Firmware của thiết bị cần được kiểm tra'), findsNothing);
      expect(find.text('Thiết lập cố định trong firmware'), findsNothing);
      expect(find.text('Độ ẩm mục tiêu'), findsNothing);
      expect(find.text('Vùng trễ'), findsNothing);
      expect(find.text('Thời lượng tưới tự động'), findsNothing);
      expect(find.text('Giới hạn chạy an toàn'), findsNothing);
      expect(find.text('Thời gian nghỉ bảo vệ bơm'), findsNothing);
      expect(
        find.textContaining('ngưỡng độ ẩm 50/100 và vùng trễ 5/100'),
        findsOneWidget,
      );
      expect(
        find.textContaining('Mỗi chu kỳ kéo dài 5 phút'),
        findsOneWidget,
      );
      expect(
        find.textContaining('tự dừng sau tối đa 15 phút'),
        findsOneWidget,
      );
      expect(
        find.textContaining('nghỉ ít nhất 1 phút'),
        findsOneWidget,
      );

      await tester.ensureVisible(find.text('Tưới nước'));
      await tester.tap(find.text('Tưới nước'));
      await tester.pump();

      expect(requests, [('water_for_duration', 300)]);
      expect(tester.takeException(), isNull, reason: 'width=$width');
    }
  });

  testWidgets(
      'hazard detail is device-first and exposes only safe siren controls',
      (tester) async {
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final requests = <(String, dynamic)>[];

    for (final width in [320.0, 375.0, 414.0, 768.0]) {
      tester.view.physicalSize = Size(width, 1500);
      requests.clear();

      await tester.pumpWidget(
        MaterialApp(
          key: ValueKey('hazard-$width'),
          theme: AppTheme.light,
          home: Scaffold(
            body: Builder(
              builder: (context) => Padding(
                padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
                child: productUiRegistry.buildDetail(
                  context,
                  device: _hazardDevice(),
                  onCapabilityChanged: (capability, value) async {
                    requests.add(
                      (capability.operations.single.operationName, value),
                    );
                  },
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pump();

      expect(tester.takeException(), isNull, reason: 'width=$width');
      for (final label in [
        'Nhiệt độ',
        'Độ ẩm',
        'Khí gas',
        'Cảm biến khói',
        'Cảm biến lửa',
      ]) {
        expect(find.text(label), findsOneWidget, reason: 'width=$width');
      }
      expect(find.text('30°C'), findsOneWidget, reason: 'width=$width');
      expect(find.text('65%'), findsOneWidget, reason: 'width=$width');
      expect(find.text('12/100'), findsOneWidget, reason: 'width=$width');
      expect(find.text('4/100'), findsOneWidget, reason: 'width=$width');
      expect(find.text('Còi báo động'), findsOneWidget, reason: 'width=$width');
      expect(find.text('Bật còi'), findsNothing, reason: 'width=$width');
      expect(
        find.text('Tắt còi tạm thời'),
        findsOneWidget,
        reason: 'width=$width',
      );
      expect(
        find.text('Thời gian tắt còi cảnh báo'),
        findsOneWidget,
        reason: 'width=$width',
      );
      expect(find.byType(Slider), findsNothing, reason: 'width=$width');
      for (final hidden in [
        'Vòng đời sự cố',
        'Sự cố đang hoạt động',
        'Nút tắt âm tại chỗ',
        'Điều khiển khác',
        'Thông số khác',
      ]) {
        expect(find.text(hidden), findsNothing, reason: 'width=$width');
      }

      expect(
        tester.getTopLeft(find.text(_hazardDevice().name)).dy,
        lessThan(tester.getTopLeft(find.text('Nhiệt độ')).dy),
      );
      expect(
        tester.getTopLeft(find.text('Nhiệt độ')).dy,
        lessThan(tester.getTopLeft(find.text('Còi báo động')).dy),
      );
      expect(
        tester.getTopLeft(find.text('Còi báo động')).dy,
        lessThan(tester.getTopLeft(find.text('Kết nối mạng')).dy),
      );

      expect(requests, isEmpty);
      expect(tester.takeException(), isNull, reason: 'width=$width');
    }
  });

  testWidgets('hazard sounding siren can be muted temporarily', (tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 1200);
    addTearDown(tester.view.reset);
    final requests = <(String, dynamic)>[];

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(
          body: Builder(
            builder: (context) => Padding(
              padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
              child: productUiRegistry.buildDetail(
                context,
                device: _hazardDevice(sirenState: 'sounding'),
                onCapabilityChanged: (capability, value) async {
                  requests.add(
                    (capability.operations.single.operationName, value),
                  );
                },
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    expect(find.text('Đang kêu'), findsOneWidget);
    expect(find.text('1 phút'), findsOneWidget);
    await tester.tap(find.text('1 phút'));
    await tester.pumpAndSettle();
    for (final duration in ['3 phút', '5 phút', '10 phút', '30 phút']) {
      expect(find.text(duration), findsOneWidget);
    }
    await tester.tap(find.text('3 phút'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Tắt còi tạm thời'));
    await tester.tap(find.text('Tắt còi tạm thời'));
    await tester.pump();

    expect(requests, [('mute_siren', 180)]);
    expect(tester.takeException(), isNull);
  });

  testWidgets('hazard standby siren can be muted before danger',
      (tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 1200);
    addTearDown(tester.view.reset);
    final requests = <(String, dynamic)>[];

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(
          body: Builder(
            builder: (context) => Padding(
              padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
              child: productUiRegistry.buildDetail(
                context,
                device: _hazardDevice(sirenState: 'silent'),
                onCapabilityChanged: (capability, value) async {
                  requests.add(
                    (capability.operations.single.operationName, value),
                  );
                },
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    expect(find.text('Đang chờ cảnh báo'), findsOneWidget);
    await tester.ensureVisible(find.text('Tắt còi tạm thời'));
    await tester.tap(find.text('Tắt còi tạm thời'));
    await tester.pump();

    expect(requests, [('mute_siren', 60)]);
    expect(tester.takeException(), isNull);
  });

  testWidgets('muted hazard siren shows warning and can be resumed immediately',
      (tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 1200);
    addTearDown(tester.view.reset);
    final requests = <(String, dynamic)>[];

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(
          body: Builder(
            builder: (context) => Padding(
              padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
              child: productUiRegistry.buildDetail(
                context,
                device: _hazardDevice(sirenState: 'muted'),
                onCapabilityChanged: (capability, value) async {
                  requests.add(
                    (capability.operations.single.operationName, value),
                  );
                },
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    expect(find.text('Đã tắt cảnh báo tạm thời'), findsOneWidget);
    expect(find.text('Cảnh báo: còi đang tắt tạm thời'), findsOneWidget);
    await tester.ensureVisible(find.text('Bật lại cảnh báo ngay'));
    await tester.tap(find.text('Bật lại cảnh báo ngay'));
    await tester.pump();

    expect(requests, [('resume_siren', 'resume')]);
    expect(tester.takeException(), isNull);
  });

  testWidgets('detail hides diagnostics and shows contextual health warnings',
      (tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 1100);
    addTearDown(tester.view.reset);

    Future<void> pumpDevice(
      DeviceModel device,
      String scenario,
    ) async {
      await tester.pumpWidget(
        MaterialApp(
          key: ValueKey(scenario),
          theme: AppTheme.light,
          home: Scaffold(
            body: Builder(
              builder: (context) => Padding(
                padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
                child: productUiRegistry.buildDetail(
                  context,
                  device: device,
                  onCapabilityChanged: (_, __) async {},
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      expect(tester.takeException(), isNull, reason: scenario);
      expect(find.text('Chẩn đoán'), findsNothing, reason: scenario);
    }

    await pumpDevice(
      _irrigationWithDiagnostics(rssi: -60, firmwareStatus: 'healthy'),
      'healthy',
    );
    expect(find.text('Kết nối Wi-Fi không ổn định'), findsNothing);
    expect(find.text('Firmware của thiết bị cần được kiểm tra'), findsNothing);

    await pumpDevice(
      _irrigationWithDiagnostics(rssi: -82, firmwareStatus: 'healthy'),
      'weak-wifi',
    );
    expect(find.text('Kết nối Wi-Fi không ổn định'), findsOneWidget);
    expect(find.text('Firmware của thiết bị cần được kiểm tra'), findsNothing);

    await pumpDevice(
      _irrigationWithDiagnostics(rssi: -60, firmwareStatus: 'fault'),
      'firmware-fault',
    );
    expect(find.text('Kết nối Wi-Fi không ổn định'), findsNothing);
    expect(
      find.text('Firmware của thiết bị cần được kiểm tra'),
      findsOneWidget,
    );
  });

  testWidgets('roof detail keeps only status, network, open close and mode',
      (tester) async {
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final requests = <(String, dynamic)>[];

    for (final width in [320.0, 390.0, 768.0]) {
      tester.view.physicalSize = Size(width, 1400);
      requests.clear();

      await tester.pumpWidget(
        MaterialApp(
          key: ValueKey('roof-$width'),
          theme: AppTheme.light,
          home: Scaffold(
            body: Builder(
              builder: (context) => Padding(
                padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
                child: productUiRegistry.buildDetail(
                  context,
                  device: _roofDevice,
                  onCapabilityChanged: (capability, value) async {
                    requests.add(
                      (capability.operations.single.operationName, value),
                    );
                  },
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pump();

      expect(tester.takeException(), isNull, reason: 'width=$width');
      expect(find.text('Trạng thái mái'), findsOneWidget);
      expect(find.text('Đang đóng'), findsOneWidget);
      expect(find.text('Cảm biến mưa'), findsOneWidget);
      expect(find.text('Khô ráo'), findsOneWidget);
      expect(find.text('Kết nối mạng'), findsOneWidget);
      expect(find.text('Mở mái'), findsOneWidget);
      expect(find.text('Đóng mái'), findsOneWidget);
      expect(find.text('Thủ công'), findsOneWidget);
      expect(find.text('Tự động'), findsOneWidget);

      for (final hidden in [
        'Chuyển động',
        'Dừng',
        'Thời gian chạy tối đa',
        'Bảo vệ khi mưa',
        'Điều kiện môi trường',
        'Thông số khác',
        'Nguồn lệnh gần nhất',
      ]) {
        expect(find.text(hidden), findsNothing, reason: 'width=$width');
      }

      expect(
        tester.getTopLeft(find.text('Kết nối mạng')).dy,
        lessThan(tester.getTopLeft(find.text('Điều khiển mái che')).dy),
      );
      expect(
        tester.getTopLeft(find.text('Mở mái')).dy,
        lessThan(tester.getTopLeft(find.text('Chế độ vận hành')).dy),
      );

      await tester.ensureVisible(find.text('Mở mái'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Mở mái'));
      await tester.pump();
      await tester.ensureVisible(find.text('Tự động'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Tự động'));
      await tester.pump();

      expect(
        requests,
        [('open', 'opening'), ('set_control_mode', 'automatic')],
      );
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

DeviceModel _hazardDevice({String sirenState = 'silent'}) => DeviceModel(
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
        const CapabilityModel(
          id: 'incident_state',
          type: 'enum',
          name: 'Vòng đời sự cố',
          value: 'idle',
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
