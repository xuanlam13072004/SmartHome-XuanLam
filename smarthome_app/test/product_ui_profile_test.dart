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

    test('does not infer a UI contract from a product identifier', () {
      expect(
        ProductUiProfile.resolve(
          explicitProfile: ProductUiProfile.generic,
          productId: 'prod_entrance_controller_v1',
        ),
        ProductUiProfile.generic,
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
