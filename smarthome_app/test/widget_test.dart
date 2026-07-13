import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:smarthome_app/main.dart';

void main() {
  testWidgets('Widget Library Preview renders without error',
      (WidgetTester tester) async {
    await tester.pumpWidget(
      const ProviderScope(child: SmartHomeApp()),
    );
    // Dùng pump thay vì pumpAndSettle vì LoadingIndicator có animation vô tận
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    
    expect(find.text('Widget Library Preview'), findsOneWidget);
    // Check if some controls are rendered
    expect(find.text('Normal Button'), findsOneWidget);
    expect(find.text('Đèn trần phòng khách'), findsOneWidget);
    expect(find.text('Chưa có thiết bị'), findsOneWidget);
  });
}
