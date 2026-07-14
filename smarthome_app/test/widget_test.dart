import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:smarthome_app/main.dart';

void main() {
  testWidgets('App Shell and Navigation renders without error',
      (WidgetTester tester) async {
    await tester.pumpWidget(
      const ProviderScope(child: SmartHomeApp()),
    );
    // Chờ frame và animation hoàn thành
    await tester.pumpAndSettle();
    
    // Đảm bảo dashboard hiện lên đầu tiên
    expect(find.text('Nhà của Lâm'), findsOneWidget);
    
    // Đảm bảo có BottomNavigationBar (NeuBottomBar item)
    expect(find.text('Tổng quan'), findsOneWidget);
    expect(find.text('Phòng'), findsOneWidget);
    expect(find.text('Kịch bản'), findsOneWidget);
    expect(find.text('Cá nhân'), findsOneWidget);
  });
}
