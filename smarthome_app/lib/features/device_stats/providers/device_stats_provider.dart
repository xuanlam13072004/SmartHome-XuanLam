import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/dio_provider.dart';
import '../data/device_stats.dart';

final deviceStatsApiProvider = Provider.autoDispose<DeviceStatsApi>(
  (ref) => DeviceStatsApi(ref.watch(dioProvider)),
);

/// Numbers of one device over one period (the Gateway caches them a few minutes).
final deviceStatsProvider = FutureProvider.autoDispose.family<DeviceStats, ({String mac, StatsRange range})>(
  (ref, key) => ref.watch(deviceStatsApiProvider).fetch(key.mac, key.range),
);
