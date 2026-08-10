import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:smarthome_app/core/core.dart';
import 'package:smarthome_app/core/widgets/widgets.dart';
import 'package:smarthome_app/domain/models/device_model.dart';
import 'package:smarthome_app/features/dashboard/models/capability_model.dart';
import 'package:smarthome_app/features/dashboard/widgets/capabilities/capability_section_panel.dart';
import 'package:smarthome_app/features/dashboard/widgets/device_hero_card.dart';
import 'package:smarthome_app/features/dashboard/widgets/device_topology_panel.dart';
import 'package:smarthome_app/domain/models/device_topology.dart';

const power = CapabilityModel(
  id: 'power',
  type: 'on_off',
  name: 'Đèn phòng khách',
  value: true,
  instance: 'main_light',
  capabilityId: 'light_controller',
  semanticRole: 'room_light',
  instanceDisplayName: 'Đèn phòng khách',
  iconName: 'lightbulb',
  displayOrder: 1,
  section: CapabilitySection.control,
  operations: [
    CapabilityOperationDescriptor(
      operationName: 'set_light_power',
      inputNames: ['value'],
    ),
  ],
);

const brightness = CapabilityModel(
  id: 'brightness',
  type: 'range',
  name: 'Độ sáng',
  value: 68,
  properties: {'min': 0, 'max': 100, 'step': 1, 'unit': '%'},
  instance: 'main_light',
  capabilityId: 'light_controller',
  semanticRole: 'room_light',
  instanceDisplayName: 'Đèn phòng khách',
  iconName: 'lightbulb',
  displayOrder: 1,
  section: CapabilitySection.control,
  operations: [
    CapabilityOperationDescriptor(
      operationName: 'set_brightness',
      inputNames: ['brightness'],
    ),
  ],
);

const mode = CapabilityModel(
  id: 'mode',
  type: 'enum',
  name: 'Chế độ hoạt động',
  value: 'auto',
  properties: {
    'options': ['auto', 'manual', 'silent'],
  },
  instance: 'main',
  capabilityId: 'mode_controller',
  semanticRole: 'operating_mode',
  instanceDisplayName: 'Chế độ hoạt động',
  iconName: 'tune',
  displayOrder: 2,
  section: CapabilitySection.control,
);

const temperature = CapabilityModel(
  id: 'temperature',
  type: 'sensor',
  name: 'Nhiệt độ ngoài trời',
  value: 28.4,
  properties: {'min': -40, 'max': 125, 'unit': '°C'},
  isReadOnly: true,
  instance: 'temperature',
  capabilityId: 'temperature_measurement',
  semanticRole: 'temperature_sensor',
  instanceDisplayName: 'Nhiệt độ ngoài trời',
  iconName: 'thermostat',
  displayOrder: 3,
  section: CapabilitySection.sensor,
);

const rssi = CapabilityModel(
  id: 'rssi',
  type: 'sensor',
  name: 'Tín hiệu',
  value: -62,
  properties: {'min': -120, 'max': 0, 'unit': 'dbm'},
  isReadOnly: true,
  instance: 'diagnostics',
  capabilityId: 'system-diagnostics',
  semanticRole: 'system-diagnostics',
  instanceDisplayName: 'System Diagnostics',
  iconName: 'monitor_heart',
  displayOrder: 99,
  section: CapabilitySection.diagnostic,
);

const connectionState = CapabilityModel(
  id: 'online',
  type: 'sensor',
  name: 'Kết nối',
  value: false,
  isReadOnly: true,
  instance: 'system',
  capabilityId: 'system_diagnostics',
  semanticRole: 'system_diagnostics',
  section: CapabilitySection.diagnostic,
);

const firmwareVersion = CapabilityModel(
  id: 'firmware_version',
  type: 'sensor',
  name: 'Phiên bản firmware',
  value: '1.2.3',
  isReadOnly: true,
  instance: 'system',
  capabilityId: 'system_diagnostics',
  semanticRole: 'system_diagnostics',
  section: CapabilitySection.diagnostic,
);

final device = DeviceModel(
  mac: 'AA:BB:CC:DD:EE:FF',
  ownerId: 'owner-1',
  name: 'Đèn phòng khách',
  productId: 'product-light',
  icon: Icons.lightbulb_rounded,
  status: DeviceStatus.online,
  rawState: const {'power': true, 'brightness': 68, 'mode': 'auto'},
  diagnostics: const {'rssi': -62},
  capabilities: const [power, brightness, mode, temperature, rssi],
  lastSeen: '2026-07-28T10:30:00.000Z',
  topology: const DeviceTopology(
    networkId: 'network-12345678',
    role: DeviceTopologyRole.node,
    epoch: 7,
    state: DeviceTopologyState.stable,
    transportMode: DeviceTransportMode.relay,
    joinRank: 2,
    activeHubMac: 'AA:BB:CC:DD:EE:01',
  ),
);

void main() {
  testWidgets('device detail layout has a single vertical scroll owner', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 844);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetPhysicalSize);

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: PageScaffold(
          scrollable: false,
          child: ListView(
            children: const [
              SizedBox(height: 1200),
            ],
          ),
        ),
      ),
    );

    await tester.pump();

    expect(tester.takeException(), isNull);
    expect(find.byType(Scrollable), findsOneWidget);
  });

  for (final themeBrightness in [Brightness.light, Brightness.dark]) {
    for (final width in [320.0, 375.0, 414.0, 768.0]) {
      testWidgets(
          'capability layout has no overflow at ${width.toInt()}px '
          'in ${themeBrightness.name} theme', (tester) async {
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = Size(width, 1400);
        addTearDown(tester.view.reset);

        await tester.pumpWidget(
          MaterialApp(
            theme: themeBrightness == Brightness.light
                ? AppTheme.light
                : AppTheme.dark,
            home: Scaffold(
              body: SingleChildScrollView(
                padding: const EdgeInsets.all(AppSpacing.md),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    DeviceHeroCard(
                      device: device,
                      primaryPower: power,
                      onPowerChanged: (_) {},
                    ),
                    const SizedBox(height: AppSpacing.xl),
                    DeviceTopologyPanel(topology: device.topology!),
                    const SizedBox(height: AppSpacing.xl),
                    CapabilitySectionPanel(
                      title: 'Điều khiển',
                      description: 'Các chức năng có thể thay đổi trực tiếp',
                      icon: Icons.tune_rounded,
                      capabilities: const [brightness, mode],
                      onCapabilityChanged: (_, __) {},
                    ),
                    const SizedBox(height: AppSpacing.xl),
                    CapabilitySectionPanel(
                      title: 'Cảm biến',
                      description: 'Trạng thái mới nhất từ thiết bị',
                      icon: Icons.sensors_rounded,
                      capabilities: const [temperature],
                      useGrid: true,
                      onCapabilityChanged: (_, __) {},
                    ),
                  ],
                ),
              ),
            ),
          ),
        );
        await tester.pump();

        expect(tester.takeException(), isNull);
        expect(find.text('Đèn phòng khách'), findsWidgets);
        expect(find.text('Độ sáng'), findsOneWidget);
        expect(find.text('Kết nối mạng'), findsOneWidget);
        expect(find.text('Qua Hub'), findsWidgets);
        expect(find.text('28.4°C'), findsOneWidget);
        expect(tester.takeException(), isNull);
      });
    }
  }

  testWidgets('read-only renderer accepts number, boolean and string values',
      (tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 800);
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(
          body: SingleChildScrollView(
            padding: const EdgeInsets.all(AppSpacing.md),
            child: CapabilitySectionPanel(
              title: 'Thông tin chỉ đọc',
              description: 'Kiểm tra renderer với nhiều kiểu dữ liệu',
              icon: Icons.info_outline_rounded,
              capabilities: const [rssi, connectionState, firmwareVersion],
              useGrid: true,
              onCapabilityChanged: (_, __) {},
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    expect(find.text('-62 dBm'), findsOneWidget);
    expect(find.text('Tắt'), findsOneWidget);
    expect(find.text('1.2.3'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
