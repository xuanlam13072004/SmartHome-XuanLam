import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:smarthome_app/main.dart';
import 'package:smarthome_app/features/auth/providers/auth_provider.dart';
import 'package:smarthome_app/features/auth/repositories/auth_repository.dart';
import 'package:smarthome_app/data/datasources/remote/device_remote_data_source.dart';
import 'package:smarthome_app/data/models/dto/device_dto.dart';
import 'package:smarthome_app/data/models/dto/product_dto.dart';

class _AuthenticatedAuthRepository implements IAuthRepository {
  @override
  Future<String?> getValidToken() async => 'widget-test-token';

  @override
  Future<String?> getToken() async => 'widget-test-token';

  @override
  Future<void> login(String email, String password) async {}

  @override
  Future<void> logout() async {}

  @override
  Future<void> register(
    String username,
    String email,
    String password,
    String fullName,
  ) async {}
}

class _EmptyDeviceRemoteDataSource implements IDeviceRemoteDataSource {
  @override
  Future<List<DeviceDto>> getDevices() async => [];

  @override
  Future<List<ProductDto>> getProducts() async => [];

  @override
  Future<void> sendCommand(
    String mac,
    String action,
    String instance,
    Map<String, dynamic> payload,
  ) async {}
}

void main() {
  testWidgets('App Shell and Navigation renders without error',
      (WidgetTester tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          authRepositoryProvider.overrideWithValue(
            _AuthenticatedAuthRepository(),
          ),
          deviceRemoteDataSourceProvider.overrideWithValue(
            _EmptyDeviceRemoteDataSource(),
          ),
        ],
        child: const SmartHomeApp(),
      ),
    );
    // Splash intentionally contains a continuously animating progress indicator,
    // so pump deterministic durations instead of pumpAndSettle().
    await tester.pump(const Duration(milliseconds: 801));
    await tester.pump(const Duration(milliseconds: 300));

    // Đảm bảo dashboard hiện lên đầu tiên
    expect(find.text('SmartHome'), findsWidgets);

    // Đảm bảo có BottomNavigationBar (NeuBottomBar item)
    expect(find.text('Tổng quan'), findsOneWidget);
    expect(find.text('Phòng'), findsOneWidget);
    expect(find.text('Kịch bản'), findsOneWidget);
    expect(find.text('Cá nhân'), findsOneWidget);
  });
}
