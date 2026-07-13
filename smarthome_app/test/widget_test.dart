// test/widget_test.dart
//
// Phase 1: Verify Design System Preview renders without error.

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:smarthome_app/main.dart';

void main() {
  testWidgets('Design System Preview renders without error',
      (WidgetTester tester) async {
    await tester.pumpWidget(
      const ProviderScope(child: SmartHomeApp()),
    );
    // Chờ frame và async operations
    await tester.pumpAndSettle();
    // AppBar title phải xuất hiện
    expect(find.text('Design System Preview'), findsOneWidget);
  });
}
