import 'package:flutter_test/flutter_test.dart';
import 'package:smarthome_app/features/products/product_ui_profile.dart';

void main() {
  group('ProductUiProfile', () {
    test('prefers the explicit catalog profile', () {
      expect(
        ProductUiProfile.resolve(
          explicitProfile: ProductUiProfile.roofController,
          productId: 'prod_unknown',
        ),
        ProductUiProfile.roofController,
      );
    });

    test('infers profiles for legacy catalog responses', () {
      expect(
        ProductUiProfile.resolve(
          explicitProfile: ProductUiProfile.generic,
          productId: 'prod_entrance_controller_v1',
        ),
        ProductUiProfile.entranceController,
      );
      expect(
        ProductUiProfile.resolve(
          explicitProfile: '',
          productId: 'prod_irrigation_manager_v1',
        ),
        ProductUiProfile.irrigationManager,
      );
    });

    test('keeps unknown products on the generic fallback', () {
      expect(
        ProductUiProfile.resolve(
          explicitProfile: '',
          productId: 'prod_future_device',
        ),
        ProductUiProfile.generic,
      );
      expect(ProductUiProfile.supportsVersion(2), isFalse);
    });
  });
}
