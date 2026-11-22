import 'package:flutter_test/flutter_test.dart';
import 'package:smarthome_app/features/payments/data/payment_models.dart';

void main() {
  test('amounts in dong', () {
    expect(formatVnd(49000), '49.000đ');
    expect(formatVnd(990000), '990.000đ');
    expect(formatVnd(0), '0đ');
  });

  test('an open order with its transfer details', () {
    final order = PaymentOrder.fromJson({
      'code': 'SHABCD2345',
      'plan': {'code': 'basic', 'name': 'Cơ bản'},
      'months': 1,
      'amount_vnd': 49000,
      'received_vnd': 20000,
      'status': 'review',
      'expires_at': '2026-11-22T05:00:00Z',
      'mock': false,
      'transfer': {
        'bank_name': 'MBBank',
        'bank_bin': '970422',
        'account_number': '0123456789',
        'account_name': 'NGUYEN VAN A',
        'amount_vnd': 29000,
        'note': 'SHABCD2345',
        'qr': '000201010212...',
      },
    });
    expect(order.open, isTrue);
    expect(order.paid, isFalse);
    expect(order.transfer!.amount, 29000);
    expect(order.planName, 'Cơ bản');
  });

  test('options and plans', () {
    final options = PaymentOptions.fromJson({
      'mode': 'mock',
      'available': true,
      'plans': [
        {
          'code': 'pro',
          'name': 'Nâng cao',
          'monthly_tokens': 5000000,
          'prices': [
            {'months': 1, 'amount_vnd': 99000},
            {'months': 12, 'amount_vnd': 990000},
          ],
        },
      ],
    });
    expect(options.mock, isTrue);
    expect(options.plans.single.prices.last.amount, 990000);
  });
}
