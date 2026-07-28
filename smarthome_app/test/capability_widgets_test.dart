import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:smarthome_app/core/core.dart';
import 'package:smarthome_app/core/widgets/widgets.dart';
import 'package:smarthome_app/domain/models/device_model.dart';
import 'package:smarthome_app/features/dashboard/models/capability_model.dart';
import 'package:smarthome_app/features/dashboard/widgets/capabilities/capability_section_panel.dart';
import 'package:smarthome_app/features/dashboard/widgets/device_hero_card.dart';

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
  commands: [
    CapabilityCommandDescriptor(
      action: 'SET_LIGHT_POWER',
      argumentNames: ['value'],
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
  commands: [
    CapabilityCommandDescriptor(
      action: 'SET_BRIGHTNESS',
      argumentNames: ['brightness'],
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
  properties: {'min': -120, 'max': 0, 'unit': 'dBm'},
  isReadOnly: true,
  instance: 'diagnostics',
  capabilityId: 'system-diagnostics',
  semanticRole: 'system-diagnostics',
  instanceDisplayName: 'System Diagnostics',
  iconName: 'monitor_heart',
  displayOrder: 99,
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
                    const SizedBox(height: AppSpacing.xl),
                    CapabilitySectionPanel(
                      title: 'Chẩn đoán',
                      description: 'Thông tin kỹ thuật và chất lượng kết nối',
                      icon: Icons.monitor_heart_rounded,
                      capabilities: const [rssi],
                      useGrid: true,
                      collapsible: true,
                      initiallyExpanded: false,
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
        expect(find.text('28.4°C'), findsOneWidget);
        expect(find.text('-62dBm'), findsNothing);

        await tester.tap(find.text('Chẩn đoán'));
        await tester.pump();
        expect(find.text('-62dBm'), findsOneWidget);
        expect(tester.takeException(), isNull);
      });
    }
  }
}
