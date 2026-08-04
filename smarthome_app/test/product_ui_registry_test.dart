import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:smarthome_app/core/core.dart';
import 'package:smarthome_app/core/widgets/widgets.dart';
import 'package:smarthome_app/domain/models/device_model.dart';
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
                    onCapabilityChanged: (_, __) {},
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
                  onCapabilityChanged: (_, __) {},
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
}

DeviceModel _device(String profile) => DeviceModel(
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
