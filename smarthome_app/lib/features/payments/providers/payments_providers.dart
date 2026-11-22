import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/dio_provider.dart';
import '../data/payment_models.dart';
import '../data/payments_api.dart';

final paymentsApiProvider = Provider.autoDispose<PaymentsApi>((ref) => PaymentsApi(ref.watch(dioProvider)));

final paymentOptionsProvider =
    FutureProvider.autoDispose<PaymentOptions>((ref) => ref.watch(paymentsApiProvider).options());

/// The account's recent orders (Gói dịch vụ → Lịch sử thanh toán).
final paymentOrdersProvider =
    FutureProvider.autoDispose<List<PaymentOrder>>((ref) => ref.watch(paymentsApiProvider).orders());
