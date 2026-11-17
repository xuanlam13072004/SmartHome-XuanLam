import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/dio_provider.dart';
import '../data/account_api.dart';
import '../data/account_models.dart';

final accountApiProvider = Provider.autoDispose<AccountApi>(
  (ref) => AccountApi(ref.watch(dioProvider)),
);

/// Profile header and counters of "Cá nhân" (one request).
final accountOverviewProvider = FutureProvider.autoDispose<AccountOverview>(
  (ref) => ref.watch(accountApiProvider).fetchOverview(),
);

/// API Gateway health for "Trạng thái hệ thống".
final serverReachableProvider = FutureProvider.autoDispose<bool>(
  (ref) => ref.watch(accountApiProvider).isServerReachable(),
);

/// Signed-in devices of this account ("Phiên đăng nhập").
final loginSessionsProvider = FutureProvider.autoDispose<List<LoginSession>>(
  (ref) => ref.watch(accountApiProvider).fetchSessions(),
);
