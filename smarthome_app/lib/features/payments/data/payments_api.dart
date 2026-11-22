import 'package:dio/dio.dart';

import 'payment_models.dart';

/// Payment endpoints (`/payments/…`) for the signed-in account.
class PaymentsApi {
  PaymentsApi(this._dio);

  final Dio _dio;

  static PaymentOrder _order(Response<Map<String, dynamic>> response) =>
      PaymentOrder.fromJson(Map<String, dynamic>.from(response.data!['order'] as Map));

  Future<PaymentOptions> options() async {
    final response = await _dio.get<Map<String, dynamic>>('/payments/options');
    return PaymentOptions.fromJson(response.data!);
  }

  /// The server sets the price; a new order replaces an unpaid one.
  Future<PaymentOrder> createOrder({required String planCode, required int months}) async {
    return _order(await _dio.post<Map<String, dynamic>>(
      '/payments/orders',
      data: {'plan_code': planCode, 'months': months},
    ));
  }

  Future<PaymentOrder> order(String code) async =>
      _order(await _dio.get<Map<String, dynamic>>('/payments/orders/${Uri.encodeComponent(code)}'));

  Future<List<PaymentOrder>> orders() async {
    final response = await _dio.get<Map<String, dynamic>>('/payments/orders');
    return [
      for (final item in response.data?['orders'] as List? ?? const [])
        PaymentOrder.fromJson(Map<String, dynamic>.from(item as Map)),
    ];
  }

  Future<void> cancel(String code) async {
    await _dio.post<void>('/payments/orders/${Uri.encodeComponent(code)}/cancel');
  }

  /// Test mode only (PAYMENT_MODE=mock): pays without money.
  Future<PaymentOrder> simulate(String code) async =>
      _order(await _dio.post<Map<String, dynamic>>('/payments/orders/${Uri.encodeComponent(code)}/simulate'));
}
